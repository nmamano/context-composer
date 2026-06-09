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
  WireMessage,
} from "./types.ts";
import { decompose } from "./decompose.ts";
import { reconcile } from "./reconcile.ts";
import { compose, type ComposeResult } from "./compose.ts";
import { fingerprintHead } from "./fingerprint.ts";
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
   *  marker) produce no event. */
  ingest(body: Record<string, unknown>): void {
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

    reconcile(this.frames, frames, {
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
    const affected = [...created.map((f) => f.id), ...grown];
    if (affected.length > 0) {
      const event = this.recordEvent("capture", affected);
      for (const f of created) f.createdEventId = event.id;
    }

    this.persist();
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

  compose(): ComposeResult {
    return compose(this.preamble, this.frames, this.envelope);
  }

  /** The frame currently awaiting an assistant response (last non-deleted turn
   *  frame). Captured at forward time so the capture has an EXPLICIT target and can't
   *  attach to whatever frame happens to be last when the async capture resolves. */
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
    return {
      id: f.id,
      kind: f.kind,
      role: f.role,
      title: f.title,
      tokenEstimate: f.tokenEstimate,
      deleted: f.deleted,
      messageCount: f.messages.length,
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
