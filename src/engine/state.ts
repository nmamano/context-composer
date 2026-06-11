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
  /** §11 Phase 3d — display summary (user-set or regenerated; metadata only). */
  summary: string | null;
  tokenEstimate: number;
  deleted: boolean;
  messageCount: number;
  /** §11 Phase 3a — a representation override (edit/compact) is in effect; the
   *  emitted content differs from the source the agent resends. */
  overridden: boolean;
  /** §11 Phase 3b — emission is the offload stub; full content at fileReference. */
  offloaded: boolean;
  fileReference: string | null;
  /** §11 Phase 3c — structural state. Absorbed parts / split originals are
   *  hidden from the default list (their absorber/children emit instead). */
  origin: Frame["origin"];
  absorbedInto: string | null;
  splitInto: string[] | null;
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

/** F-045: the suggestion-mode marker — the literal prefix the client puts on
 *  a suggestion side-query's opening user text. Exact-prefix match on the
 *  frame's FIRST message's first text content, after leading-whitespace trim.
 *  See the call site in summarize() for the full design rationale (this is
 *  the engine's single authorized content heuristic — do not generalize). */
const SUGGESTION_MARKER = "[SUGGESTION MODE";

/** F-062 (plan-gated, reviewer: "CAP=2 is the right pragmatic bound"): total
 *  auto-enrichment APPLIES per frame — one initial fill + one re-enrich after
 *  material content growth. Bounds the sonnet@low burn even though resend
 *  churn (ephemeral reminder blocks) can keep changing the content signature. */
const ENRICH_RUNS_CAP = 2;

/** F-053 (Phase 5e, Nil-authorized 2026-06-10; reviewer-gated): brittle
 *  exception #2 to the locked "no content heuristics" principle. Claude Code
 *  embeds an `x-anthropic-billing-header: ...; cch=...;` line in the system
 *  text whose cch value is rewritten per request by the client's HTTP layer
 *  (a per-request attestation token — CC source confirmed via the office CC
 *  Expert). That made the preamble look "grown" on EVERY request, flooding
 *  the timeline with p0 capture entries and defeating the no-change→no-event
 *  suppression. This strips lines starting with the exact literal below when
 *  computing the PREAMBLE's change-detection signature — and NOWHERE else:
 *  stored p0 stays byte-faithful to the latest resend (the attestation line
 *  keeps riding the wire — it is the client's attestation), turn frames never
 *  normalize, compose/tokens untouched. Graceful degradation: if the client
 *  renames the header, behavior degrades to today's noise. Do not generalize. */
const VOLATILE_HEADER_PREFIX = "x-anthropic-billing-header:";

function stripVolatileHeaderLines<T>(system: T): T {
  const stripText = (t: string) =>
    t
      .split("\n")
      .filter((l) => !l.startsWith(VOLATILE_HEADER_PREFIX))
      .join("\n");
  if (typeof system === "string") return stripText(system) as unknown as T;
  if (Array.isArray(system)) {
    return system.map((b) =>
      b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string"
        ? { ...(b as object), text: stripText((b as { text: string }).text) }
        : b,
    ) as unknown as T;
  }
  return system;
}

function opensWithSuggestionMarker(f: Frame): boolean {
  const first = f.messages[0];
  if (!first) return false;
  let text = "";
  if (typeof first.content === "string") {
    text = first.content;
  } else if (Array.isArray(first.content)) {
    for (const b of first.content) {
      if (b.type === "text" && typeof b.text === "string") {
        text = b.text;
        break;
      }
    }
  }
  // F-055: the live wire sends the marker as plain "[SUGGESTION MODE:" — the
  // original gated literal carried a leading "*" transcribed from Nil's
  // prose and never matched real content. Accept optional leading asterisks
  // (markdown-italic wrapping) after the whitespace trim; nothing wider.
  return text.trimStart().replace(/^\*+/, "").startsWith(SUGGESTION_MARKER);
}

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
        origin: "captured",
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
      if (f.representation || f.absorbedInto || f.splitInto) {
        f.tokenEstimate = this.effectiveTokens(f);
      }
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
      // F-052: request-side capture — an arriving request created/changed these.
      const event = this.recordEvent("capture", affected, null, null, "request");
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
   *  edit/compact/revert, every site where either may change). §11 Phase 3c:
   *  absorbed parts and split originals emit nothing themselves (their absorber/
   *  children carry the estimate) — 0 while structurally hidden. */
  private effectiveTokens(f: Frame): number {
    if (f.absorbedInto || (f.splitInto && f.splitInto.length > 0)) return 0;
    return estimateTokens(f.representation ?? f.messages);
  }

  /** Normalized content signature of a frame (cache_control stripped, deterministic
   *  bytes) — used only to tell a real content change from a no-op resend.
   *  F-053: the PREAMBLE signature additionally ignores the client's volatile
   *  billing-header line (see stripVolatileHeaderLines) — signature ONLY;
   *  stored content stays byte-faithful and turn frames never normalize. */
  private contentSig(f: Frame): string {
    const payload =
      f.kind === "preamble"
        ? {
            system:
              f.system != null ? stripVolatileHeaderLines(f.system) : null,
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
      origin: "captured",
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
    // F-052: reply-side capture.
    this.recordEvent("capture", [target.id], null, null, "reply");
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
    // applicable: preamble, no view emitted yet, or MANUFACTURED frames (§11
    // Phase 3c — never view members, yet added frames always emit and combined/
    // children emit via resolution; flagging them fork-only would mislead).
    let inLastView =
      f.kind === "turn" && f.origin === "captured" && this.lastEmittedView
        ? this.lastEmittedView.frameIds.includes(f.id)
        : null;
    // F-045 (Phase 5e, Nil-authorized 2026-06-10; reviewer-gated): the ONE
    // content heuristic in the engine — a deliberate, narrow exception to the
    // locked "no content heuristics" principle. A frame opening with the
    // client's suggestion-mode marker is a fork-only frame in waiting; without
    // this it is classified only after the NEXT main-thread request reveals a
    // view without it. Brittle by ACCEPTED design (Nil: "the downside is
    // basically what we have now") — if the client changes the marker, this
    // degrades to late classification. Derived annotation ONLY: list/summarize
    // and their consumers; no persistence, no reconcile/compose/membership
    // change. Applies to ANY currently-true captured turn frame (reviewer:
    // stacked suggestion turns must not strand the earlier one).
    if (inLastView === true && opensWithSuggestionMarker(f)) inLastView = false;
    return {
      id: f.id,
      kind: f.kind,
      role: f.role,
      title: f.title,
      summary: f.summary ?? null,
      tokenEstimate: f.tokenEstimate,
      deleted: f.deleted,
      messageCount: f.messages.length,
      overridden: !!f.representation,
      offloaded: f.offloaded,
      fileReference: f.fileReference,
      origin: f.origin,
      absorbedInto: f.absorbedInto ?? null,
      splitInto: f.splitInto && f.splitInto.length > 0 ? f.splitInto : null,
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
      // Structurally hidden frames (absorbed parts / split originals) are not
      // deletable — they already emit nothing themselves; revert the combine/
      // split to operate on them. Skipped, not marked (§11 Phase 3c).
      if (f && (f.absorbedInto || (f.splitInto && f.splitInto.length > 0))) continue;
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
    // Guards via opTarget (§11 Phase 3c): preamble deferred (temporary, not
    // semantic — §2.7), deleted/offloaded/absorbed/split all refuse with the
    // revert-or-restore-first pattern that keeps structural state coherent.
    const t = this.opTarget(id, type);
    if (!t.ok) return t;
    const f = t.frame;

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
    const pre = this.show(id);
    if (pre?.offloaded) {
      return { ok: false, error: `frame ${id} is already offloaded — restore it first` };
    }
    const t = this.opTarget(id, "offload");
    if (!t.ok) return t;
    const f = t.frame;

    const emission = f.representation ?? f.messages;
    const rendered = renderFrameMarkdown(f.id, f.title, emission);
    const hash = sha256(rendered).slice(0, 12);
    const path = join(this.framesDir, `${this.namespace}-${f.id}-${hash}.md`);
    // Local-only conversation data: dir 0700, file 0600 (same posture as the
    // store and the wiretap). A write failure surfaces as a clean op error via
    // the control API's catch — state is not mutated before the write.
    mkdirSync(this.framesDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, rendered, { mode: 0o600 });

    // F-017 (plans/ui-feedback.md, plan-gated): the frame's own summary —
    // typically the ingest-enrichment auto-summary — beats the deterministic
    // first-line derivation. Explicit opts.summary still wins over everything.
    // NOTE: this changes what compose emits for newly offloaded frames when
    // f.summary exists (intended; applies to UI, control API, and CLI alike).
    const summary =
      opts.summary ?? f.summary ?? deriveSummary(emission) ?? `offloaded frame ${f.id}`;
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

  /** `combine` (§5.B, §11 Phase 3c): merge ≥2 frames into one. The parts STAY in
   *  the store as the reconcile match targets (their source identity is
   *  unchanged — matching stays 1:1); they are marked absorbed and compose
   *  resolves them to the combined frame, emitted ONCE at the first part's slot
   *  (Appendix C's many-to-many emission, implemented as indirection). The
   *  combined frame's messages are the parts' EMISSIONS at combine time
   *  (representation ?? messages), concatenated. Parts' sources may keep
   *  refreshing from resends; compose ignores their content while absorbed
   *  (reviewer RC4, option a). */
  combine(ids: string[], opts: { after?: string | null } = {}): OpResult {
    if (ids.length < 2 || new Set(ids).size !== ids.length) {
      return { ok: false, error: "combine needs at least 2 distinct frame ids" };
    }
    const parts: Frame[] = [];
    for (const id of ids) {
      const t = this.opTarget(id, "combine");
      if (!t.ok) return t;
      const refusal = this.refuseStructuralProduct(t.frame, "combine");
      if (refusal) return refusal;
      parts.push(t.frame);
    }
    // F-047: optional EXPLICIT placement — validated like add() (id must
    // exist; null = start; absorbed parts are valid anchors — they keep their
    // order spine slot). Omitted: today's behavior byte-for-byte (no
    // placement; the combined frame emits at the first part's slot via
    // resolution).
    let placement: { after: string | null } | null = null;
    if (opts.after !== undefined) {
      if (opts.after === null) {
        placement = { after: null };
      } else {
        if (!this.frames.some((f) => f.id === opts.after)) {
          return { ok: false, error: `--after target ${opts.after} does not exist` };
        }
        placement = { after: opts.after };
      }
    }
    const messages = structuredClone(
      parts.flatMap((p) => p.representation ?? p.messages),
    );
    const combined = this.makeManufactured("combined", messages);
    if (placement) combined.placement = placement;
    const commit = this.makeCommit(
      "combine",
      [...ids, combined.id],
      {
        partIds: [...ids],
        combinedId: combined.id,
        ...(placement ? { placement: structuredClone(placement) } : {}),
      },
      `combine ${ids.join("+")} -> ${combined.id}`,
    );
    combined.provenance.push(commit.id);
    this.frames.push(combined);
    for (const p of parts) {
      p.absorbedInto = combined.id;
      p.tokenEstimate = this.effectiveTokens(p); // 0 while structurally hidden
      p.modifiedAt = ++this.seq;
      p.provenance.push(commit.id);
    }
    this.commits.record(commit);
    this.recordEvent("combine", [...ids, combined.id], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** `split` (§5.B, §11 Phase 3c): split one frame's EMISSION into several at
   *  message boundaries (block-level splitting deferred). The original stays as
   *  the match target, marked split; compose resolves it to the children, in
   *  order, at its slot. Children deep-clone their message ranges and are
   *  ordinary frames thereafter. */
  split(id: string, at: number[]): OpResult {
    const t = this.opTarget(id, "split");
    if (!t.ok) return t;
    const refusal = this.refuseStructuralProduct(t.frame, "split");
    if (refusal) return refusal;
    const f = t.frame;
    const emission = f.representation ?? f.messages;
    if (emission.length < 2) {
      return {
        ok: false,
        error: `frame ${id} emits only ${emission.length} message(s) — nothing to split at a message boundary`,
      };
    }
    const bounds = [...new Set(at)].sort((a, b) => a - b);
    if (
      bounds.length === 0 ||
      bounds.some((b) => !Number.isInteger(b) || b <= 0 || b >= emission.length)
    ) {
      return {
        ok: false,
        error: `--at boundaries must be distinct integers between 1 and ${emission.length - 1}`,
      };
    }
    const ranges: WireMessage[][] = [];
    let start = 0;
    for (const b of bounds) {
      ranges.push(structuredClone(emission.slice(start, b)));
      start = b;
    }
    ranges.push(structuredClone(emission.slice(start)));

    const children = ranges.map((r) => this.makeManufactured("split", r));
    const childIds = children.map((c) => c.id);
    const commit = this.makeCommit(
      "split",
      [id, ...childIds],
      { originalId: id, childIds, at: bounds },
      `split ${id} -> ${childIds.join("+")}`,
    );
    for (const c of children) {
      c.provenance.push(commit.id);
      this.frames.push(c);
    }
    f.splitInto = childIds;
    f.tokenEstimate = this.effectiveTokens(f); // 0 while structurally hidden
    f.modifiedAt = ++this.seq;
    f.provenance.push(commit.id);
    this.commits.record(commit);
    this.recordEvent("split", [id, ...childIds], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  // ---- §11 Phase 3d sub-frame content ops ----

  /** `strip` (§5.C): remove tool-result BLOAT inside a frame while keeping the
   *  reasoning AND the tool structure. Semantics (reviewer point A): the
   *  targeted tool_result blocks keep type/tool_use_id/is_error — only their
   *  `content` is replaced with a short stub note, so the tool_use/result pair
   *  stays intact and the §5.F sweep remains a safety net, not the mechanism. */
  strip(id: string, target: { resultIds?: string[]; all?: boolean }): OpResult {
    return this.transformResults("strip", id, target, "[stripped by user]");
  }

  /** `summarize` (§5.C): same transform as strip with a user/LLM summary as the
   *  replacement. Multi-result semantics: ONE summary repeated across every
   *  selected result (3d simplicity, reviewer point D). The LLM lives at the
   *  proxy layer (`--regen`); the store only ever receives text — deterministic. */
  summarizeResults(
    id: string,
    target: { resultIds?: string[]; all?: boolean },
    text: string,
  ): OpResult {
    return this.transformResults("summarize", id, target, text);
  }

  private transformResults(
    type: "strip" | "summarize",
    id: string,
    target: { resultIds?: string[]; all?: boolean },
    replacement: string,
  ): OpResult {
    // Content-op guards: deleted/offloaded/absorbed/split-original/preamble
    // refuse; added/combined/split-child frames are ordinary emitting content.
    const t = this.opTarget(id, type);
    if (!t.ok) return t;
    const f = t.frame;

    const emission = structuredClone(f.representation ?? f.messages);
    const wanted = target.all ? null : new Set(target.resultIds ?? []);
    if (wanted && wanted.size === 0) {
      return { ok: false, error: `${type} needs --result <tool_use_id...> or --all-results` };
    }
    // Duplicate tool_use_ids in a raw-authored representation: ALL matching
    // blocks transform deterministically; params record ids + block count.
    const affected: string[] = [];
    let blocks = 0;
    for (const m of emission) {
      if (typeof m.content === "string") continue;
      for (let i = 0; i < m.content.length; i++) {
        const b = m.content[i]!;
        if (b.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        if (wanted && !wanted.has(b.tool_use_id)) continue;
        m.content[i] = { ...b, content: replacement }; // ONLY content changes
        affected.push(b.tool_use_id);
        blocks++;
      }
    }
    // No-mutation refusals: zero matches, or any requested id unmatched.
    if (blocks === 0) {
      return {
        ok: false,
        error: target.all
          ? `frame ${id} has no tool_result blocks`
          : `frame ${id} has no tool_result matching ${[...wanted!].join(", ")} — nothing changed`,
      };
    }
    if (wanted) {
      const found = new Set(affected);
      const missing = [...wanted].filter((x) => !found.has(x));
      if (missing.length > 0) {
        return {
          ok: false,
          error: `frame ${id} has no tool_result matching ${missing.join(", ")} — nothing changed`,
        };
      }
    }

    const before = f.representation ? structuredClone(f.representation) : null;
    const commit = this.makeCommit(
      type,
      [id],
      { before, after: structuredClone(emission), resultIds: affected, blocks },
      `${type} ${id} (${blocks} result block(s))`,
    );
    f.representation = emission;
    f.tokenEstimate = this.effectiveTokens(f);
    f.modifiedAt = ++this.seq;
    f.provenance.push(commit.id);
    this.commits.record(commit);
    this.recordEvent(type, [id], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** `retitle` (§5.C): set/replace display metadata (title + §7 summary). PURE
   *  metadata — never touches emission, head hash, or tokens — so it is allowed
   *  on ANY non-deleted frame: preamble, offloaded, absorbed parts, split
   *  originals, structural products (helps label hidden frames). */
  retitle(id: string, opts: { title?: string; summary?: string }): OpResult {
    if (opts.title === undefined && opts.summary === undefined) {
      return { ok: false, error: "retitle needs --title and/or --summary" };
    }
    const f = this.show(id);
    if (!f) return { ok: false, error: `no frame ${id}` };
    if (f.deleted) {
      return { ok: false, error: `frame ${id} is deleted — revert the delete first` };
    }
    const before = { title: f.title, summary: f.summary ?? null };
    const after = {
      title: opts.title ?? f.title,
      summary: opts.summary !== undefined ? opts.summary : (f.summary ?? null),
    };
    const commit = this.makeCommit("retitle", [id], { before, after }, `retitle ${id}`);
    f.title = after.title;
    f.summary = after.summary;
    f.modifiedAt = ++this.seq;
    f.provenance.push(commit.id);
    this.commits.record(commit);
    this.recordEvent("retitle", [id], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** F-062: a field is APPLICABLE when auto-enrichment may write it — still
   *  the fill state (title = makeFrame placeholder / summary = null), or
   *  still AUTO-OWNED (its current value equals the last auto-applied value
   *  recorded in f.enrichment; null per field = never auto-applied). A manual
   *  retitle/summarize changes the value → mismatch → auto never overwrites
   *  it again, per field, forever. Old-store frames lack f.enrichment and are
   *  therefore fill-only (the recorded residual: they cannot be safely told
   *  apart from manually titled frames; no backfill without Nil's say-so). */
  private enrichApplicable(f: Frame): { title: boolean; summary: boolean } {
    return {
      title:
        f.title === `frame ${f.id}` ||
        (f.enrichment?.title != null && f.title === f.enrichment.title),
      summary:
        f.summary == null ||
        (f.enrichment?.summary != null && f.summary === f.enrichment.summary),
    };
  }

  /** Engine batch H (F-062, plan-gated): the ONE eligibility authority the
   *  server's enrichment queue consults before burning an LLM call. Eligible =
   *  CONTENT eligibility (a fill-state field exists, OR the frame was
   *  auto-enriched, its content signature materially changed since the last
   *  apply, and the re-run cap is not exhausted) AND at least one field is
   *  applicable (reviewer adjustment #1: sig-change alone must not trigger a
   *  call when both fields went manual — it would apply nothing). Signature
   *  comparison stays engine-private (adjustment #2). */
  enrichEligible(id: string): boolean {
    const f = this.show(id);
    if (!f || f.kind !== "turn" || f.deleted) return false;
    const a = this.enrichApplicable(f);
    if (!a.title && !a.summary) return false;
    const fill =
      (a.title && f.title === `frame ${f.id}`) || (a.summary && f.summary == null);
    if (fill) return true;
    if (!f.enrichment) return false; // applicable but no fill ⇒ needs the auto record
    return (
      f.enrichment.runs < ENRICH_RUNS_CAP &&
      this.contentSig(f) !== f.enrichment.sig
    );
  }

  /** Engine batch A (plans/ui-feedback.md F-001, plan-gated): METADATA FILL
   *  from async ingest enrichment; batch H (F-062, plan-gated) extends it to
   *  RE-ENRICH. The server layer generates {title, summary} and applies it
   *  here under LATEST-state checks (reviewer condition #5): the frame must
   *  still exist, still be a turn frame, not deleted; each field applies only
   *  while it is still fill-state OR still auto-owned (enrichApplicable) — so
   *  a manual retitle ALWAYS wins, per field, value-anchored. Fields that no
   *  longer qualify are skipped; if nothing applies, NO event and no
   *  ownership/sig/runs update. On apply, f.enrichment records the new
   *  auto-owned values (unapplied fields keep their prior record — a manual
   *  field stays correctly non-owned), the CURRENT content signature, and the
   *  incremented total-applies count (the queue's eligibility cap reads it).
   *  Deliberately NOT a commit (no per-turn history flooding — this mirrors
   *  the placeholder stamped at capture); audited via an `enriched` timeline
   *  event carrying the filled fields + provider label (condition #1 — never
   *  raw prompt/output, only the values already visible on the frame). */
  enrich(
    id: string,
    opts: { title?: string; summary?: string; source?: string },
  ): { ok: true; applied: Array<"title" | "summary"> } | { ok: false; error: string } {
    const f = this.show(id);
    if (!f) return { ok: false, error: `no frame ${id}` };
    if (f.kind !== "turn") {
      return { ok: false, error: `frame ${id} is not a turn frame` };
    }
    if (f.deleted) return { ok: false, error: `frame ${id} is deleted` };
    const a = this.enrichApplicable(f);
    const applied: Array<"title" | "summary"> = [];
    if (opts.title !== undefined && a.title) {
      f.title = opts.title;
      applied.push("title");
    }
    if (opts.summary !== undefined && a.summary) {
      f.summary = opts.summary;
      applied.push("summary");
    }
    if (applied.length === 0) return { ok: true, applied };
    f.enrichment = {
      title: applied.includes("title") ? f.title : (f.enrichment?.title ?? null),
      summary: applied.includes("summary")
        ? (f.summary ?? null)
        : (f.enrichment?.summary ?? null),
      sig: this.contentSig(f),
      runs: (f.enrichment?.runs ?? 0) + 1,
    };
    f.modifiedAt = ++this.seq;
    this.recordEvent(
      "enriched",
      [id],
      null,
      `${applied.join("+")}${opts.source ? ` via ${opts.source}` : ""}`,
    );
    this.persist();
    return { ok: true, applied };
  }

  /** The commit that established a frame's CURRENT offload: its most recent
   *  `offload` commit. Valid lookup because offloaded frames refuse edit/compact
   *  and (below) refuse reverts of other content commits — so while offloaded,
   *  the last content commit IS the offload. Shared by restore() and the revert
   *  coherence guard. */
  private currentOffloadCommit(f: Frame): Commit | null {
    return this.lastCommitOfType(f, "offload");
  }

  private lastCommitOfType(f: Frame, type: CommitType): Commit | null {
    for (let i = f.provenance.length - 1; i >= 0; i--) {
      const c = this.commits.get(f.provenance[i]!);
      if (c && c.type === type) return c;
    }
    return null;
  }

  // ---- §11 Phase 3c structural ops ----

  /** Manufactured frame factory (origin added/combined/split): sentinel anchor
   *  (never collides with a sha-hex fingerprint, never recomputed on restore —
   *  unmatchable by design, reviewer RC1), createdEventId permanently null (the
   *  creating COMMIT lives in provenance). */
  private makeManufactured(
    origin: "added" | "combined" | "split",
    messages: WireMessage[],
  ): Frame {
    const id = `t${++this.turnCounter}`;
    return {
      id,
      kind: "turn",
      role: messages[0]?.role === "assistant" ? "assistant" : "user",
      title: `frame ${id}`,
      anchorFp: `manufactured:${origin}:${id}`,
      occurrence: 0,
      messages,
      stopReason: null,
      tokenEstimate: estimateTokens(messages),
      deleted: false,
      origin,
      offloaded: false,
      fileReference: null,
      provenance: [],
      createdEventId: null,
      createdAt: ++this.seq,
      modifiedAt: this.seq,
    };
  }

  /** Common guard for ops needing a LIVE, structurally-unencumbered turn frame. */
  private opTarget(
    id: string,
    op: string,
  ): { ok: true; frame: Frame } | { ok: false; error: string } {
    const f = this.show(id);
    if (!f) return { ok: false, error: `no frame ${id}` };
    if (f.kind === "preamble") {
      return { ok: false, error: `${op} on the preamble is not yet supported (deferred)` };
    }
    if (f.deleted) {
      return { ok: false, error: `frame ${id} is deleted — revert the delete first` };
    }
    if (f.offloaded) {
      return { ok: false, error: `frame ${id} is offloaded — restore it first` };
    }
    if (f.absorbedInto) {
      return { ok: false, error: `frame ${id} is absorbed into ${f.absorbedInto} — revert the combine first` };
    }
    if (f.splitInto && f.splitInto.length > 0) {
      return { ok: false, error: `frame ${id} was split into ${f.splitInto.join(", ")} — revert the split first` };
    }
    return { ok: true, frame: f };
  }

  /** §11 Phase 3c (reviewer-caught): combine/split/move refuse STRUCTURAL
   *  PRODUCTS (origin combined/split). Nested absorption and move-over-
   *  absorption are separate ordering/coherence models the 3c revert guards do
   *  not reason about — combined frames and split children stay ordinary for
   *  edit/compact/offload/delete only. Added frames remain fully operable. */
  private refuseStructuralProduct(f: Frame, op: string): OpResult | null {
    if (f.origin === "combined" || f.origin === "split") {
      const undo = f.origin === "combined" ? "combine" : "split";
      return {
        ok: false,
        error: `frame ${f.id} is a ${f.origin} structural product — ${op} on it is not supported (revert the ${undo} first)`,
      };
    }
    return null;
  }

  /** `add` (§5.B, §11 Phase 3c): create a frame the agent never produced — an
   *  instruction/note/seed. NO source identity (sentinel anchor): it is never
   *  matched by a resend, so it is a member of EVERY emission by USER OP — the
   *  one deliberate membership extension beyond the request (2.7 guardrail).
   *  Default placement: after the last live turn frame at add time. */
  add(input: RepInput, opts: { after?: string | null } = {}): OpResult {
    let messages: WireMessage[];
    if ("text" in input) {
      messages = [{ role: "user", content: input.text }];
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
      messages = structuredClone(input.raw);
    }

    let after: string | null;
    if (opts.after === undefined) {
      // "End of the conversation" = after the last live CAPTURED frame: other
      // manufactured frames may themselves be placed anywhere, so anchoring to
      // the store tail could chain the new note behind an earlier insertion.
      const last = [...this.frames]
        .reverse()
        .find((f) => !f.deleted && f.origin === "captured");
      after = last ? last.id : null;
    } else if (opts.after === null) {
      after = null; // explicit start
    } else {
      if (!this.frames.some((f) => f.id === opts.after)) {
        return { ok: false, error: `--after target ${opts.after} does not exist` };
      }
      after = opts.after;
    }

    const f = this.makeManufactured("added", messages);
    f.placement = { after };
    const commit = this.makeCommit(
      "add",
      [f.id],
      { content: structuredClone(messages), placement: { after } },
      `add ${f.id}`,
    );
    f.provenance.push(commit.id);
    this.frames.push(f);
    this.commits.record(commit);
    this.recordEvent("add", [f.id], commit.id);
    this.persist();
    return { ok: true, commit };
  }

  /** `move` (§5.B, §11 Phase 3c): reorder an EXISTING member's emission slot.
   *  Strictly an ordering override — move never creates membership: a fork-only
   *  frame that is moved still stays off emissions whose request didn't carry
   *  it (reviewer RC2). Caching note (§9): moving early frames re-tokenizes the
   *  tail. */
  move(id: string, opts: { after: string | null }): OpResult {
    const t = this.opTarget(id, "move");
    if (!t.ok) return t;
    // A combined frame emits at its first part's slot and children emit at the
    // original's slot — placement is not consulted there, so a move would be
    // silently ineffective. Refuse rather than record a no-op commit.
    const refusal = this.refuseStructuralProduct(t.frame, "move");
    if (refusal) return refusal;
    const f = t.frame;
    if (opts.after === id) {
      return { ok: false, error: `cannot move ${id} after itself` };
    }
    if (opts.after !== null && !this.frames.some((x) => x.id === opts.after)) {
      return { ok: false, error: `--after target ${opts.after} does not exist` };
    }
    const before = f.placement ? { ...f.placement } : null;
    const commit = this.makeCommit(
      "move",
      [id],
      { before, after: { after: opts.after } },
      `move ${id} ${opts.after === null ? "to start" : `after ${opts.after}`}`,
    );
    f.placement = { after: opts.after };
    f.modifiedAt = ++this.seq;
    f.provenance.push(commit.id);
    this.commits.record(commit);
    this.recordEvent("move", [id], commit.id);
    this.persist();
    return { ok: true, commit };
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
    const revertible = [
      "delete", "edit", "compact", "offload", "restore", "add", "move", "combine", "split",
      "strip", "summarize", "retitle",
    ];
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
    if (target.type !== "delete" && target.type !== "retitle") {
      // Structural-state coherence guards (3b pattern, generalized for 3c).
      // delete AND retitle are exempt: neither touches representation or
      // structural metadata (tombstone / display metadata only).
      // while a frame is offloaded/absorbed/split, only the commit that
      // ESTABLISHED that state may be reverted — anything else would swap the
      // emission or metadata out from under the active structure.
      for (const id of target.affectedFrameIds) {
        const f = this.show(id)!;
        if (f.offloaded) {
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
        if (f.absorbedInto) {
          const current = this.lastCommitOfType(f, "combine");
          if (!current || current.id !== target.id) {
            return {
              ok: false,
              error: `frame ${id} is absorbed into ${f.absorbedInto} — revert the combine first`,
            };
          }
        }
        if (f.splitInto && f.splitInto.length > 0) {
          const current = this.lastCommitOfType(f, "split");
          if (!current || current.id !== target.id) {
            return {
              ok: false,
              error: `frame ${id} was split — revert the split first`,
            };
          }
        }
      }
    }
    // Precise structural-revert eligibility (reviewer E): revert must restore a
    // COHERENT structural state, never half-clear metadata.
    if (target.type === "combine") {
      const { partIds, combinedId } = target.params as {
        partIds: string[];
        combinedId: string;
      };
      const combined = this.show(combinedId)!;
      if (combined.deleted) {
        return { ok: false, error: `combined frame ${combinedId} is deleted — revert the delete first` };
      }
      // STATE-based pristine check (not history-based): downstream commits that
      // have themselves been reverted leave the frame coherent again, and the
      // combine may then be reverted. Live downstream state blocks it.
      // F-047: the combine commit may ITSELF have set a placement — that is
      // this commit's own state, not downstream; only a placement that
      // DIFFERS from the recorded one (a later move) blocks.
      const ownPlacement =
        (target.params as { placement?: { after: string | null } }).placement ?? null;
      const placementChanged =
        JSON.stringify(combined.placement ?? null) !== JSON.stringify(ownPlacement);
      if (combined.representation || combined.offloaded || placementChanged) {
        return {
          ok: false,
          error: `combined frame ${combinedId} has downstream state (edit/offload/move) — revert those first`,
        };
      }
      for (const pid of partIds) {
        if (this.show(pid)!.absorbedInto !== combinedId) {
          return {
            ok: false,
            error: `frame ${pid} is no longer absorbed by ${combinedId} — cannot revert ${target.id}`,
          };
        }
      }
    }
    if (target.type === "split") {
      const { originalId, childIds } = target.params as {
        originalId: string;
        childIds: string[];
      };
      const original = this.show(originalId)!;
      if (JSON.stringify(original.splitInto ?? []) !== JSON.stringify(childIds)) {
        return {
          ok: false,
          error: `frame ${originalId} no longer points at exactly ${childIds.join(", ")} — cannot revert ${target.id}`,
        };
      }
      for (const cid of childIds) {
        const child = this.show(cid)!;
        if (child.deleted) {
          return { ok: false, error: `split child ${cid} is deleted — revert the delete first` };
        }
        // State-based pristine check — same rationale as revert(combine).
        if (child.representation || child.offloaded || child.placement) {
          return { ok: false, error: `split child ${cid} has downstream state (edit/offload/move) — revert those first` };
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
      } else if (target.type === "add") {
        // Append-only un-create (§11 Phase 3c, reviewer point B): the added
        // frame is tombstoned — still showable and audit-complete. Note: the
        // resulting tombstone is part of the revert commit, so it cannot be
        // revert-of-reverted in this phase (revert commits are not revertible).
        f.deleted = true;
      } else if (target.type === "move") {
        const params = target.params as { before?: { after: string | null } | null };
        f.placement = params.before ? { ...params.before } : null;
      } else if (target.type === "retitle") {
        const params = target.params as { before?: { title: string; summary: string | null } };
        if (params.before) {
          f.title = params.before.title;
          f.summary = params.before.summary;
        }
      } else if (target.type === "combine") {
        const { combinedId } = target.params as { combinedId: string };
        if (f.id === combinedId) {
          f.deleted = true; // append-only un-create of the manufactured frame
        } else {
          f.absorbedInto = null; // part resumes emitting itself
          f.tokenEstimate = this.effectiveTokens(f);
        }
      } else if (target.type === "split") {
        const { originalId } = target.params as { originalId: string };
        if (f.id === originalId) {
          f.splitInto = null; // original resumes emitting itself
          f.tokenEstimate = this.effectiveTokens(f);
        } else {
          f.deleted = true; // children tombstoned (append-only un-create)
        }
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
    note: string | null = null,
    // F-052: capture subtype (request|reply); pass ONLY from the two capture
    // sites — every other event type leaves it unset.
    direction: "request" | "reply" | null = null,
  ): ContextEvent {
    const event: ContextEvent = {
      id: `e${++this.eventCounter}`,
      type,
      frameIds,
      commitId,
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      ...(note !== null ? { note } : {}),
      ...(direction !== null ? { direction } : {}),
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
      // MANUFACTURED frames (origin added/combined/split) keep their persisted
      // sentinel anchors: recomputing from messages would hand them a REAL
      // anchor that could match a future resend (§11 Phase 3c, reviewer RC1 —
      // the 3a restore-identity trap, inverted).
      if (f.origin !== "captured") continue;
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
