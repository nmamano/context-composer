// FrameStore — the authoritative frame state (design.md §11 "long-lived proxy daemon
// holds the authoritative frame state"). The proxy mutates it on every /v1/messages;
// the CLI mutates it through the control API. There is ONE live state; CLI and proxy
// share it in-process, not through disk (locked decision).
//
// Phase 2 makes it DURABLE-BACKED: an optional Persistence port (JSON-on-disk) is loaded
// on construct and saved after every mutation. No persistence (the default) = pure
// in-memory, i.e. exact Phase 1 behavior — which is what the existing tests rely on.
//
// Two classes of mutation:
//   • USER mutating ops (`delete`, `revert`) record an implicit COMMIT (§2.3/§5.E) and
//     show up in `history`.
//   • Session-ingest events (`ingest` of a new turn, `captureAssistant`) are the
//     automatic `persist` of §5.D — they persist for resume but are NOT commits, so the
//     §5/§7 operation enum stays intact and `history` shows only user operations.

import type {
  DecomposedFrame,
  Frame,
  RequestEnvelope,
  RequestView,
  WireMessage,
} from "./types.ts";
import { decompose } from "./decompose.ts";
import { reconcile } from "./reconcile.ts";
import { compose, type ComposeResult } from "./compose.ts";
import { fingerprintHead, fingerprintMessage } from "./fingerprint.ts";
import { canonicalStringify, stripCacheControlDeep } from "./canonical.ts";
import { estimateTokens } from "./tokens.ts";
import type { CapturedAssistant } from "./sse.ts";
import { CommitGraph, type Commit, type CommitType } from "./commit-graph.ts";
import {
  EventLog,
  type ContextEvent,
  type ContextEventType,
} from "./event-log.ts";
import { SNAPSHOT_VERSION, type Persistence, type StoreSnapshot } from "./store.ts";

export interface FrameSummary {
  id: string;
  kind: Frame["kind"];
  role: Frame["role"];
  title: string;
  tokenEstimate: number;
  deleted: boolean;
  messageCount: number;
  /** §11 Phase 2.7 — was this frame in the LAST emitted view? `false` flags a
   *  fork-only frame (stored, visible, deletable — but the next emission of the
   *  thread that didn't carry it will exclude it). `null` when not applicable:
   *  the preamble (head representation, never view membership) or when no view
   *  has been emitted yet (fresh store / post-restart — views are derived per
   *  request and never persisted). */
  inLastView: boolean | null;
}

/** Result of a `revert` — a clear error (Phase 2 refuses ambiguous reverts) or the new
 *  inverse commit. */
export type RevertResult =
  | { ok: true; commit: Commit }
  | { ok: false; error: string };

export class FrameStore {
  private preamble: Frame | null = null;
  private frames: Frame[] = []; // turn frames in order, including tombstones
  private envelope: RequestEnvelope = {};
  private seq = 0;
  private turnCounter = 0;
  private commitCounter = 0;
  private eventCounter = 0;
  private commits = new CommitGraph();
  private events = new EventLog();
  private persistence: Persistence | null;
  /** §11 Phase 2.7 — the last view COMPOSED FOR THE WIRE on the owned path (the
   *  "attempted outbound" view: recorded right after compose, before forward, so a
   *  request that 502s upstream still counts — deterministic and matched 1:1 by the
   *  wiretap entry). NON-PERSISTENT by design: views are derived per request;
   *  after a restart this is null until the next owned request. */
  private lastEmittedView: RequestView | null = null;

  /** @param persistence durable backing store; `null` = pure in-memory (Phase 1). */
  constructor(persistence: Persistence | null = null) {
    this.persistence = persistence;
    const snap = this.persistence?.load();
    if (snap) this.restore(snap);
  }

  /** Ingest one rendered request: decompose → refresh head → reconcile turn frames.
   *  Records a `capture` EVENT for any frame created OR materially grown this turn (so the
   *  timeline is complete — a tool_result/assistant continuation arriving via the unaware
   *  resend is visible), persists. A capture is NOT a commit — it never lands in `history`
   *  or in a frame's `provenance`. Identical resends (incl. a relocated `cache_control`
   *  marker) produce no event.
   *
   *  Returns the REQUEST VIEW (§11 Phase 2.7): the turn frames this request matched
   *  or appended, in incoming order, tombstone matches included — what compose
   *  emits for THIS request, and where its response capture must land. The view's
   *  createdIds/grownIds are TURN-ONLY and deliberately decoupled from the capture
   *  event's affected set below (which may include the preamble — head
   *  representation, never view membership). */
  ingest(body: Record<string, unknown>): RequestView {
    const { system, tools, injectedSystem, envelope, frames } = decompose(body);
    this.envelope = envelope;

    // Pre-ingest content signatures of existing frames, to detect material growth below
    // (vs the no-op resends the unaware agent sends every turn).
    const before = new Map<string, string>();
    if (this.preamble) before.set(this.preamble.id, this.contentSig(this.preamble));
    for (const f of this.frames) before.set(f.id, this.contentSig(f));

    const created: Frame[] = [];
    const headFp = fingerprintHead(system, tools);
    if (!this.preamble) {
      this.preamble = {
        id: "p0",
        kind: "preamble",
        role: "system",
        title: "preamble (system + tools)",
        anchorFp: headFp,
        occurrence: 0,
        messages: [],
        system,
        tools,
        injectedSystem,
        tokenEstimate: estimateTokens(system) + estimateTokens(tools),
        deleted: false,
        provenance: [],
        createdEventId: null,
        createdAt: ++this.seq,
        modifiedAt: this.seq,
      };
      created.push(this.preamble);
    } else if (!this.preamble.deleted) {
      // Refresh head content. In practice the head is stable (that's the cache
      // contract); refreshing simply captures any change the agent makes.
      this.preamble.system = system;
      this.preamble.tools = tools;
      this.preamble.injectedSystem = injectedSystem;
      this.preamble.anchorFp = headFp;
      this.preamble.tokenEstimate =
        estimateTokens(system) + estimateTokens(tools);
    }

    const viewFrameIds = reconcile(this.frames, frames, {
      makeFrame: (inc) => {
        const f = this.makeFrame(inc);
        created.push(f);
        return f;
      },
      estimate: (m) => estimateTokens(m),
      nextSeq: () => ++this.seq,
    });

    // Existing frames whose NORMALIZED content materially changed this ingest — i.e. grew
    // via a tool-loop / assistant continuation in the resend (Appendix C: live frames may
    // grow). Created frames aren't in `before`, so they're never counted as "grown".
    const grown: string[] = [];
    const noteIfChanged = (f: Frame | null) => {
      if (f && before.has(f.id) && before.get(f.id) !== this.contentSig(f)) {
        grown.push(f.id);
      }
    };
    noteIfChanged(this.preamble);
    for (const f of this.frames) noteIfChanged(f);

    // One capture event per ingest that created OR grew frames; stamp each NEW frame with
    // its origin event so the timeline can explain where it came from. No change → no
    // event (the unaware agent's identical resends don't flood the timeline).
    // NOTE: this affected set may include the PREAMBLE (created/grown head) — that is
    // correct for the timeline and must stay; the RequestView below filters to turn
    // frames separately. Do not unify the two.
    const affected = [...created.map((f) => f.id), ...grown];
    if (affected.length > 0) {
      const event = this.recordEvent("capture", affected);
      for (const f of created) f.createdEventId = event.id;
    }

    this.persist();

    // Derive the request view (§11 Phase 2.7). Membership + order come from THIS
    // request (reconcile's mapping); the store supplies each member's representation
    // at compose time. openFrameId is the last NON-DELETED frame OF THE VIEW — the
    // capture target — never the store tail (a fork's reply must not land on, or
    // steal, a main-thread frame).
    const byId = new Map(this.frames.map((f) => [f.id, f]));
    let openFrameId: string | null = null;
    for (let i = viewFrameIds.length - 1; i >= 0; i--) {
      const f = byId.get(viewFrameIds[i]!);
      if (f && !f.deleted) {
        openFrameId = f.id;
        break;
      }
    }
    return {
      frameIds: viewFrameIds,
      openFrameId,
      // Turn-only: `created`/`grown` above feed the capture event and may include
      // the preamble; the view never does (byId holds turn frames only).
      createdIds: created.filter((f) => f.kind === "turn").map((f) => f.id),
      grownIds: grown.filter((id) => byId.has(id)),
    };
  }

  /** Normalized content signature of a frame (cache_control stripped, deterministic
   *  bytes) — used only to tell a real content change from a no-op resend. */
  private contentSig(f: Frame): string {
    const payload =
      f.kind === "preamble"
        ? {
            system: f.system ?? null,
            tools: f.tools ?? null,
            injectedSystem: f.injectedSystem ?? null,
          }
        : { messages: f.messages };
    return canonicalStringify(stripCacheControlDeep(payload));
  }

  private makeFrame(inc: DecomposedFrame): Frame {
    const occurrence = this.frames.filter(
      (f) => f.anchorFp === inc.anchorFp,
    ).length;
    return {
      id: `t${++this.turnCounter}`,
      kind: "turn",
      role: inc.role,
      title: `frame t${this.turnCounter}`, // placeholder; titling deferred (Phase 3)
      anchorFp: inc.anchorFp,
      occurrence,
      messages: inc.messages,
      stopReason: null,
      tokenEstimate: estimateTokens(inc.messages),
      deleted: false,
      provenance: [],
      createdEventId: null, // stamped by ingest once the capture event is recorded
      createdAt: ++this.seq,
      modifiedAt: this.seq,
    };
  }

  /** Compose the wire body. With a view (§11 Phase 2.7): emit exactly the view's
   *  frames (tombstones honored — deleted wins); the owned /v1/messages path always
   *  passes the current request's view. Without a view: the full-store union —
   *  preserved for control/debug surfaces only. PURE — no side effects; recording
   *  the emitted view is the caller's explicit step (noteEmittedView). */
  compose(view?: RequestView): ComposeResult {
    return compose(this.preamble, this.frames, this.envelope, view);
  }

  /** Record the view just composed for the wire (the "attempted outbound" view —
   *  see the field doc; recorded even if the upstream forward subsequently fails).
   *  Arrays are cloned so later accidental mutation by the caller cannot rewrite
   *  history. Non-persistent; never part of the snapshot. */
  noteEmittedView(view: RequestView): void {
    this.lastEmittedView = {
      frameIds: [...view.frameIds],
      openFrameId: view.openFrameId,
      createdIds: [...view.createdIds],
      grownIds: [...view.grownIds],
    };
  }

  /** The last emitted ("attempted outbound") view, or null if none since startup —
   *  views are derived per request and never persisted (§11 Phase 2.7). Returns a
   *  clone (matching noteEmittedView's defensive-copy intent) so library/test
   *  callers can't accidentally rewrite the last-view annotation. */
  lastView(): RequestView | null {
    if (!this.lastEmittedView) return null;
    return {
      frameIds: [...this.lastEmittedView.frameIds],
      openFrameId: this.lastEmittedView.openFrameId,
      createdIds: [...this.lastEmittedView.createdIds],
      grownIds: [...this.lastEmittedView.grownIds],
    };
  }

  /** The frame currently awaiting an assistant response (last non-deleted turn
   *  frame OF THE STORE). Phase 2.7: the owned path now targets the VIEW's
   *  openFrameId instead (RequestView.openFrameId), so a fork's capture lands on
   *  the fork's own open frame; this store-tail variant remains for tests/library
   *  callers that operate single-conversation, where the two coincide. */
  openFrameId(): string | null {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      if (!this.frames[i]!.deleted) return this.frames[i]!.id;
    }
    return null;
  }

  /** Attach a captured assistant response to a SPECIFIC frame (its id captured at
   *  forward time), so `list`/`show` reflect it immediately — before the agent resends
   *  it next turn. On that resend, reconcile refreshes the frame from the authoritative
   *  copy. No-op if the target vanished or was deleted meanwhile. Persists on success
   *  (session-ingest, NOT a commit) so a restart resumes with the assistant message. */
  captureAssistant(captured: CapturedAssistant, targetId: string | null): void {
    if (!targetId) return;
    const target = this.frames.find((f) => f.id === targetId);
    if (!target || target.deleted) return;
    target.messages = [...target.messages, captured.message];
    target.stopReason = captured.stopReason;
    target.tokenEstimate = estimateTokens(target.messages);
    target.modifiedAt = ++this.seq;
    // The assistant's reply arriving is also the context being shaped — a capture event,
    // not a commit. Keeps the timeline complete without polluting the op log.
    this.recordEvent("capture", [target.id]);
    this.persist();
  }

  // ---- control surface (CLI calls these via the proxy's /control/* routes) ----

  list(): FrameSummary[] {
    const out: FrameSummary[] = [];
    if (this.preamble) out.push(this.summarize(this.preamble));
    for (const f of this.frames) out.push(this.summarize(f));
    return out;
  }

  private summarize(f: Frame): FrameSummary {
    // Fork-only annotation (§11 Phase 2.7): a turn frame absent from the last
    // emitted view is stored-but-not-sent on that thread — surfaced so users
    // understand why side-query frames exist before deleting them. null = not
    // applicable (preamble, or no view emitted yet).
    const inLastView =
      f.kind === "turn" && this.lastEmittedView
        ? this.lastEmittedView.frameIds.includes(f.id)
        : null;
    return {
      id: f.id,
      kind: f.kind,
      role: f.role,
      title: f.title,
      tokenEstimate: f.tokenEstimate,
      deleted: f.deleted,
      messageCount: f.messages.length,
      inLastView,
    };
  }

  show(id: string): Frame | null {
    if (this.preamble && this.preamble.id === id) return this.preamble;
    return this.frames.find((f) => f.id === id) ?? null;
  }

  /** Delete = tombstone + an implicit `delete` commit (USER op). Returns the ids
   *  actually marked. Records/persists only when something was actually deleted. */
  delete(ids: string[]): string[] {
    const marked: string[] = [];
    for (const id of ids) {
      const f = this.show(id);
      if (f && !f.deleted) {
        f.deleted = true;
        f.modifiedAt = ++this.seq;
        marked.push(id);
      }
    }
    if (marked.length > 0) {
      const commit = this.makeCommit(
        "delete",
        marked,
        {},
        `delete ${marked.join(", ")}`,
      );
      for (const id of marked) this.show(id)!.provenance.push(commit.id);
      this.commits.record(commit);
      this.recordEvent("delete", marked, commit.id); // timeline mirrors the commit
      this.persist();
    }
    return marked;
  }

  /** Revert a `delete` commit (append-only inverse commit, git-revert style — never a
   *  history rewrite). No arg → the HEAD commit, but ONLY if it is itself revertible.
   *  Phase 2 deliberately refuses ambiguous reverts with a clear error rather than
   *  silently toggling state. */
  revert(commitId?: string): RevertResult {
    const target = commitId ? this.commits.get(commitId) : this.commits.getHead();
    if (!target) {
      return {
        ok: false,
        error: commitId ? `no commit ${commitId}` : "no commits to revert",
      };
    }
    if (target.type !== "delete") {
      return {
        ok: false,
        error: `commit ${target.id} is a ${target.type}; Phase 2 can only revert delete commits`,
      };
    }
    if (this.commits.isReverted(target.id)) {
      return { ok: false, error: `commit ${target.id} was already reverted` };
    }
    const missing = target.affectedFrameIds.filter((id) => !this.show(id));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `cannot revert ${target.id}: frame(s) ${missing.join(", ")} no longer exist`,
      };
    }

    const commit = this.makeCommit(
      "revert",
      target.affectedFrameIds,
      { revertedCommitId: target.id },
      `revert ${target.id}`,
    );
    for (const id of target.affectedFrameIds) {
      const f = this.show(id)!;
      f.deleted = false; // lift the tombstone; the frame resumes absorbing the resend
      f.modifiedAt = ++this.seq;
      f.provenance.push(commit.id);
    }
    this.commits.record(commit);
    this.recordEvent("revert", target.affectedFrameIds, commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** The user commit log (§5.E) — `delete`/`revert` only; ingest/capture never appear.
   *  This is the version-control history (`ctx history`). */
  history(): Commit[] {
    return this.commits.history();
  }

  /** The complete, ordered audit timeline (`ctx timeline`) — every store mutation,
   *  captures included. The commit graph is the revertible subset of this. */
  timeline(): ContextEvent[] {
    return this.events.list();
  }

  private recordEvent(
    type: ContextEventType,
    frameIds: string[],
    commitId: string | null = null,
  ): ContextEvent {
    const event: ContextEvent = {
      id: `e${++this.eventCounter}`,
      type,
      frameIds,
      commitId,
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
    };
    this.events.append(event);
    return event;
  }

  private makeCommit(
    type: CommitType,
    affectedFrameIds: string[],
    params: Record<string, unknown>,
    note: string,
  ): Commit {
    return {
      id: `c${++this.commitCounter}`,
      type,
      affectedFrameIds,
      params,
      note,
      branchId: "main", // single linear branch in Phase 2 (branches are Phase 4)
      parentCommitId: this.commits.headId(),
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
    };
  }

  // ---- durability ----

  private snapshot(): StoreSnapshot {
    const cg = this.commits.snapshot();
    return {
      version: SNAPSHOT_VERSION,
      preamble: this.preamble,
      frames: this.frames,
      envelope: this.envelope,
      commits: cg.commits,
      head: cg.head,
      events: this.events.snapshot(),
      seq: this.seq,
      turnCounter: this.turnCounter,
      commitCounter: this.commitCounter,
      eventCounter: this.eventCounter,
    };
  }

  private restore(s: StoreSnapshot): void {
    this.preamble = s.preamble;
    this.frames = s.frames;
    this.envelope = s.envelope;
    // Self-healing identity: anchor fingerprints are DERIVED values (opening message /
    // head), so recompute them on load instead of trusting persisted bytes — a
    // fingerprint-algorithm change must never silently fork identities against a stale
    // store (the resend would stop matching and every frame would duplicate).
    if (this.preamble) {
      this.preamble.anchorFp = fingerprintHead(this.preamble.system, this.preamble.tools);
    }
    const seen = new Map<string, number>();
    for (const f of this.frames) {
      if (f.messages.length > 0) f.anchorFp = fingerprintMessage(f.messages[0]!);
      const n = seen.get(f.anchorFp) ?? 0;
      f.occurrence = n;
      seen.set(f.anchorFp, n + 1);
    }
    this.commits.restore({ commits: s.commits, head: s.head });
    this.events.restore(s.events);
    this.seq = s.seq;
    this.turnCounter = s.turnCounter;
    this.commitCounter = s.commitCounter;
    this.eventCounter = s.eventCounter;
  }

  private persist(): void {
    this.persistence?.save(this.snapshot());
  }
}
