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
//   • USER mutating ops (`delete`, `edit`, `compact`, `revert`) record an implicit
//     COMMIT (§2.3/§5.E) and show up in `history`.
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
import { canonicalStringify, sha256, stripCacheControlDeep } from "./canonical.ts";
import { estimateTokens } from "./tokens.ts";
import type { CapturedAssistant } from "./sse.ts";
import { CommitGraph, type Commit, type CommitType } from "./commit-graph.ts";
import {
  EventLog,
  type ContextEvent,
  type ContextEventType,
} from "./event-log.ts";
import { SNAPSHOT_VERSION, type Persistence, type StoreSnapshot } from "./store.ts";
import { deriveSummary, renderFrameMarkdown } from "./offload.ts";
import { FRAMES_DIR } from "../config.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FrameSummary {
  id: string;
  kind: Frame["kind"];
  role: Frame["role"];
  title: string;
  tokenEstimate: number;
  deleted: boolean;
  messageCount: number;
  /** §11 Phase 3a — a representation override (edit/compact) is in effect; the
   *  emitted content differs from the source the agent resends. */
  overridden: boolean;
  /** §11 Phase 3b — emission is the offload stub; full content at fileReference. */
  offloaded: boolean;
  fileReference: string | null;
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

/** Result of a content op (`edit`/`compact`, §11 Phase 3a). */
export type OpResult =
  | { ok: true; commit: Commit }
  | { ok: false; error: string };

/** Input for a content op: `--text` (single message carrying the frame opener's
 *  role) or `--raw` (full authorship of the frame's emitted messages array —
 *  the advanced form that can express any intermediate state; the §5.F sweep
 *  guarantees the WIRE stays valid, per "total control by capture, not
 *  constraint"). */
export type RepInput = { text: string } | { raw: WireMessage[] };

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

  /** @param persistence durable backing store; `null` = pure in-memory (Phase 1).
   *  @param namespace prefix for offload artifact filenames (§11 Phase 3b) — the
   *  registry passes its conv id (derived, never persisted); direct library/test
   *  stores get a safe default.
   *  @param framesDir where offload artifacts are written; defaults to the
   *  configured absolute FRAMES_DIR (tests pass a tmp dir). */
  constructor(
    persistence: Persistence | null = null,
    private readonly namespace: string = "mem",
    private readonly framesDir: string = FRAMES_DIR,
  ) {
    this.persistence = persistence;
    const snap = this.persistence?.load();
    if (snap) this.restoreSnapshot(snap);
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
        offloaded: false,
        fileReference: null,
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

    // Token invariant (§11 Phase 3a): `tokenEstimate` tracks the EMITTED
    // representation. Reconcile's refresh just recomputed matched frames from
    // their SOURCE resend — correct for un-overridden frames, wrong for frames
    // carrying an edit/compact override (list/conversations would count the
    // full source as live while compose emits the override). Re-assert the
    // invariant here; matching/mapping in reconcile stays untouched.
    for (const f of this.frames) {
      if (f.representation) f.tokenEstimate = this.effectiveTokens(f);
    }

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

  /** Token estimate of what compose EMITS for a turn frame: the override when
   *  set, else the source (§11 Phase 3a invariant — see ingest/captureAssistant/
   *  edit/compact/revert, every site where either may change). */
  private effectiveTokens(f: Frame): number {
    return estimateTokens(f.representation ?? f.messages);
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
      offloaded: false,
      fileReference: null,
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
    // Capture appends to SOURCE only (source material arriving). If the frame
    // carries an edit/compact override, authorship wins: the reply is stored and
    // visible in `show`, but compose keeps emitting the override until the user
    // edits/clears it (§11 Phase 3a, reviewer-approved edge).
    target.messages = [...target.messages, captured.message];
    target.stopReason = captured.stopReason;
    target.tokenEstimate = this.effectiveTokens(target);
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
      overridden: !!f.representation,
      offloaded: f.offloaded,
      fileReference: f.fileReference,
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

  /** `edit` (§5.C, §11 Phase 3a): set the frame's representation override — full
   *  user authorship over what the model sees. The SOURCE `messages` are never
   *  touched (identity + reconcile refresh stay source-based; the Appendix C
   *  refresh-gate holds by construction). Records an `edit` commit whose params
   *  carry { before, after } representation values, so revert is append-only
   *  invertible. */
  edit(id: string, input: RepInput): OpResult {
    return this.setRepresentation("edit", id, input);
  }

  /** `compact` (§5.C, §11 Phase 3a): replace the frame's emission with a summary.
   *  3a is the deterministic manual tracer (`--text <summary>`); LLM-backed
   *  `--regen` lands with the other LLM ops (3d). Identical machinery to `edit`
   *  with its own commit type. */
  compact(id: string, input: RepInput): OpResult {
    return this.setRepresentation("compact", id, input);
  }

  private setRepresentation(
    type: "edit" | "compact",
    id: string,
    input: RepInput,
  ): OpResult {
    const f = this.show(id);
    if (!f) return { ok: false, error: `no frame ${id}` };
    if (f.kind === "preamble") {
      // Temporary 3a limitation, NOT a semantic rule — the preamble is just a
      // frame (§2.7) and head ops arrive with the offload slice (3b)/demo beats.
      return { ok: false, error: `${type} on the preamble is not yet supported (deferred past 3a)` };
    }
    if (f.deleted) {
      return { ok: false, error: `frame ${id} is deleted — revert the delete first` };
    }
    if (f.offloaded) {
      // Reviewer-required guard (3b): edit/compact of an offloaded frame would
      // leave stale offload metadata on a non-stub representation and muddy
      // revert. Keep the current offload the LAST content commit on the frame.
      return { ok: false, error: `frame ${id} is offloaded — restore it first` };
    }

    // Build the new representation. --text carries the frame opener's role
    // (reviewer point 2: compact must not change role authorship as a side
    // effect); --raw is full authorship, deep-cloned so later caller mutation
    // can't reach the store.
    let after: WireMessage[];
    if ("text" in input) {
      const role = f.role === "assistant" ? "assistant" : "user";
      after = [{ role, content: input.text }];
    } else {
      if (
        !Array.isArray(input.raw) ||
        input.raw.length === 0 ||
        !input.raw.every(
          (m) =>
            m &&
            (m.role === "user" || m.role === "assistant") &&
            (typeof m.content === "string" || Array.isArray(m.content)),
        )
      ) {
        return {
          ok: false,
          error: `--raw must be a non-empty WireMessage[] (role user|assistant, content string|blocks)`,
        };
      }
      after = structuredClone(input.raw);
    }

    const before = f.representation ? structuredClone(f.representation) : null;
    const commit = this.makeCommit(type, [id], { before, after: structuredClone(after) }, `${type} ${id}`);
    f.representation = after;
    f.tokenEstimate = this.effectiveTokens(f);
    f.modifiedAt = ++this.seq;
    f.provenance.push(commit.id);
    this.commits.record(commit);
    this.recordEvent(type, [id], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** `offload` (§5.D, §11 Phase 3b): swap the frame's emission for a short stub
   *  (note + summary + ABSOLUTE artifact path) and render the full pre-offload
   *  EMISSION (representation ?? messages) to disk for the wrapped agent to read
   *  back with its own file-read tool (provider assumption 5). The artifact
   *  filename embeds a content hash, so a committed fileReference keeps pointing
   *  at the bytes rendered for THAT offload even after later offloads of the
   *  same frame (append-only revert invariant; identical content re-offloads to
   *  the identical path — idempotent). The store stays the durable truth. */
  offload(id: string, opts: { summary?: string } = {}): OpResult {
    const f = this.show(id);
    if (!f) return { ok: false, error: `no frame ${id}` };
    if (f.kind === "preamble") {
      return { ok: false, error: `offload on the preamble is not yet supported (deferred past 3b)` };
    }
    if (f.deleted) {
      return { ok: false, error: `frame ${id} is deleted — revert the delete first` };
    }
    if (f.offloaded) {
      return { ok: false, error: `frame ${id} is already offloaded — restore it first` };
    }

    const emission = f.representation ?? f.messages;
    const rendered = renderFrameMarkdown(f.id, f.title, emission);
    const hash = sha256(rendered).slice(0, 12);
    const path = join(this.framesDir, `${this.namespace}-${f.id}-${hash}.md`);
    // Local-only conversation data: dir 0700, file 0600 (same posture as the
    // store and the wiretap). A write failure surfaces as a clean op error via
    // the control API's catch — state is not mutated before the write.
    mkdirSync(this.framesDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, rendered, { mode: 0o600 });

    const summary =
      opts.summary ?? deriveSummary(emission) ?? `offloaded frame ${f.id}`;
    // User-role stub (deliberate departure from edit/compact role preservation):
    // this is OUR note to the model inviting a file read, not a reconstruction
    // of the original speaker. The §5.F sweep handles any role adjacency.
    const stub: WireMessage[] = [
      {
        role: "user",
        content:
          `[OFFLOADED FRAME ${f.id}] Summary: ${summary}. ` +
          `The full content is on disk at ${path} — read that file if you need the details.`,
      },
    ];

    const before = f.representation ? structuredClone(f.representation) : null;
    const commit = this.makeCommit(
      "offload",
      [id],
      { before, after: structuredClone(stub), fileReference: path },
      `offload ${id} -> ${path}`,
    );
    f.representation = stub;
    f.offloaded = true;
    f.fileReference = path;
    f.tokenEstimate = this.effectiveTokens(f);
    f.modifiedAt = ++this.seq;
    f.provenance.push(commit.id);
    this.commits.record(commit);
    this.recordEvent("offload", [id], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** `restore` (§5.D): re-inject the offloaded frame's pre-offload emission
   *  inline — a USER convenience only (the model reads the file itself). Finds
   *  the offload's `before` via the frame's last offload commit (safe: offloaded
   *  frames refuse edit/compact, so that commit IS the last content commit).
   *  The artifact file stays on disk — it is a rendering; the store is the truth. */
  restore(id: string): OpResult {
    const f = this.show(id);
    if (!f) return { ok: false, error: `no frame ${id}` };
    if (!f.offloaded) {
      return { ok: false, error: `frame ${id} is not offloaded` };
    }
    const offloadCommit = this.currentOffloadCommit(f);
    if (!offloadCommit) {
      return { ok: false, error: `frame ${id} is offloaded but has no offload commit (corrupt provenance?)` };
    }
    const restored =
      (offloadCommit.params as { before?: WireMessage[] | null }).before ?? null;

    const commit = this.makeCommit(
      "restore",
      [id],
      {
        before: structuredClone(f.representation),
        after: restored ? structuredClone(restored) : null,
        fileReference: f.fileReference,
      },
      `restore ${id}`,
    );
    f.representation = restored ? structuredClone(restored) : null;
    f.offloaded = false;
    f.fileReference = null;
    f.tokenEstimate = this.effectiveTokens(f);
    f.modifiedAt = ++this.seq;
    f.provenance.push(commit.id);
    this.commits.record(commit);
    this.recordEvent("restore", [id], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** The commit that established a frame's CURRENT offload: its most recent
   *  `offload` commit. Valid lookup because offloaded frames refuse edit/compact
   *  and (below) refuse reverts of other content commits — so while offloaded,
   *  the last content commit IS the offload. Shared by restore() and the revert
   *  coherence guard. */
  private currentOffloadCommit(f: Frame): Commit | null {
    for (let i = f.provenance.length - 1; i >= 0; i--) {
      const c = this.commits.get(f.provenance[i]!);
      if (c && c.type === "offload") return c;
    }
    return null;
  }

  /** Revert a `delete`/`edit`/`compact`/`offload`/`restore` commit (append-only
   *  inverse commit, git-revert style — never a history rewrite). No arg → the
   *  HEAD commit, but ONLY if it is itself revertible. Ambiguous reverts are
   *  refused with a clear error rather than silently toggling state. For content
   *  ops the inverse restores ONLY representation/offload-metadata/provenance/
   *  modifiedAt — never source `messages` (reviewer point 6).
   *
   *  Metadata-coherence guard (§11 Phase 3b, reviewer-caught): while a frame is
   *  OFFLOADED, its representation is the stub at fileReference — reverting any
   *  content commit other than the current offload itself would swap the
   *  emission out from under that state (offloaded=true, non-stub emission:
   *  drift). So while offloaded, only the current offload commit is revertible
   *  for that frame; everything else: restore first. (delete reverts are
   *  unaffected — they touch only the tombstone, never representation.) */
  revert(commitId?: string): RevertResult {
    const target = commitId ? this.commits.get(commitId) : this.commits.getHead();
    if (!target) {
      return {
        ok: false,
        error: commitId ? `no commit ${commitId}` : "no commits to revert",
      };
    }
    const revertible = ["delete", "edit", "compact", "offload", "restore"];
    if (!revertible.includes(target.type)) {
      return {
        ok: false,
        error: `commit ${target.id} is a ${target.type}; only ${revertible.join("/")} commits can be reverted`,
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
    if (target.type !== "delete") {
      for (const id of target.affectedFrameIds) {
        const f = this.show(id)!;
        if (!f.offloaded) continue;
        const current = this.currentOffloadCommit(f);
        if (!current || current.id !== target.id) {
          return {
            ok: false,
            error:
              `frame ${id} is offloaded — restore it first ` +
              `(while offloaded, only its current offload commit can be reverted)`,
          };
        }
      }
    }

    const commit = this.makeCommit(
      "revert",
      target.affectedFrameIds,
      { revertedCommitId: target.id },
      `revert ${target.id}`,
    );
    for (const id of target.affectedFrameIds) {
      const f = this.show(id)!;
      if (target.type === "delete") {
        f.deleted = false; // lift the tombstone; the frame resumes absorbing the resend
      } else {
        // Content-op inverse: restore the prior representation value (which may
        // be null = no override). Source `messages` are never touched.
        const params = target.params as {
          before?: WireMessage[] | null;
          fileReference?: string | null;
        };
        f.representation = params.before ? structuredClone(params.before) : null;
        // Offload metadata follows the representation (§11 Phase 3b):
        // revert(offload) un-offloads; revert(restore) re-instates the stub AND
        // its committed fileReference — which still points at the right bytes
        // because artifact filenames are content-hashed (never overwritten).
        if (target.type === "offload") {
          f.offloaded = false;
          f.fileReference = null;
        } else if (target.type === "restore") {
          f.offloaded = true;
          f.fileReference = params.fileReference ?? null;
        }
        f.tokenEstimate = this.effectiveTokens(f);
      }
      f.modifiedAt = ++this.seq;
      f.provenance.push(commit.id);
    }
    this.commits.record(commit);
    this.recordEvent("revert", target.affectedFrameIds, commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** The user commit log (§5.E) — `delete`/`edit`/`compact`/`revert`; ingest/capture
   *  never appear. This is the version-control history (`ctx history`). */
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

  private restoreSnapshot(s: StoreSnapshot): void {
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
