// Phase 1 data model — a deliberately narrow subset of design.md §7.
//
// We model only what the tracer bullet needs: a uniform Frame (no frame types —
// a preamble frame is just a frame, per §2.7), wire messages, and the request
// envelope of runtime knobs we own-but-must-not-drop.

export type Role = "user" | "assistant" | "system";

/** An Anthropic content block (text, tool_use, tool_result, image, …). Opaque to us. */
export type Block = Record<string, unknown>;

/** A message as it appears in the `messages` array of a /v1/messages body. */
export interface WireMessage {
  role: "user" | "assistant";
  content: string | Block[];
}

/**
 * A frame: the addressable unit the whole system operates on.
 *
 * Identity is anchored to the frame's *opening* message (`anchorFp`) plus its
 * `occurrence` among frames that share that fingerprint. The opening message is
 * stable while the frame grows (assistant reply, tool loop), so identity holds
 * across turns even as content accretes — this is what lets reconciliation match
 * a frame the unaware agent keeps resending.
 */
export interface Frame {
  id: string;
  // PLACEMENT/location helper for Phase 1 display — NOT a semantic frame type.
  // Frames stay uniform and ops stay uniform (§2.7, no frame types). Phase 2 may
  // rename this to `placement`/`source` if it persists as metadata.
  kind: "preamble" | "turn";
  role: Role;
  title: string; // Phase 1: placeholder; LLM titling is deferred (Phase 3).

  // Identity anchor (turn frames). See reconcile.ts.
  anchorFp: string;
  occurrence: number;

  // Turn frames carry wire messages; preamble carries system + tools.
  messages: WireMessage[];
  system?: string | Block[];
  tools?: Block[];

  // Preamble only: agent-injected system-role blocks lifted out of `messages`
  // (the spike's injected block, §2.7 / decision F). Captured into the head so we
  // never forward an invalid `system` role inside the messages array.
  injectedSystem?: Block[];

  // Last observed stop_reason for a turn frame ("tool_use" => loop continues).
  stopReason?: string | null;

  tokenEstimate: number;

  /** Tombstone. A deleted frame stays authoritative: reconcile matches it so the
   *  unaware agent's resend of the same content does NOT re-add it, and compose
   *  omits it. Recoverable via `revert` (Phase 2). Deleted wins over
   *  `representation`: a tombstoned frame emits nothing regardless of override. */
  deleted: boolean;

  /** §11 Phase 3c — where this frame came from. "captured" frames have REAL
   *  source identity (anchorFp from the agent's bytes; recomputed on snapshot
   *  restore). All other origins are MANUFACTURED (user op products): their
   *  anchors are unmatchable sentinels and snapshot restore must NEVER recompute
   *  them from messages — a manufactured frame acquiring a real anchor could
   *  match a future resend (the 3a restore-identity trap, inverted). */
  origin: "captured" | "added" | "combined" | "split";

  /** §11 Phase 3c — emission-order override (add/move). `after: null` = at the
   *  start; `after: <frameId>` = right after that frame's emission slot; absent
   *  = natural order. Anchor-absence fallback is deterministic (see compose). */
  placement?: { after: string | null } | null;

  /** §11 Phase 3c — set on a combine PART: this frame's emission is delegated to
   *  the absorbing combined frame (emitted once, at the first part's slot). The
   *  part remains the reconcile match target; its source may keep refreshing,
   *  but compose ignores its content while absorbed. Structural ops/edits on
   *  absorbed parts refuse ("revert the combine first"). */
  absorbedInto?: string | null;

  /** §11 Phase 3c — set on a split ORIGINAL: emission is delegated to the child
   *  frames, in order, at the original's slot. Same rules as absorbedInto. */
  splitInto?: string[] | null;

  /** §11 Phase 3b — the frame's emission is currently the offload stub; the full
   *  rendered content lives at `fileReference`. Explicit (not derived from
   *  provenance) because restore/revert/list behavior reads cleaner. Offloaded
   *  frames refuse edit/compact ("restore first") so the current offload is
   *  always the last content commit. */
  offloaded: boolean;
  /** Absolute path of the rendered artifact for the CURRENT offload (null when
   *  not offloaded). The filename embeds a content hash, so a committed
   *  fileReference keeps pointing at the bytes rendered for THAT offload even
   *  after later offloads of the same frame (append-only revert invariant). */
  fileReference: string | null;

  /** Representation override (§5.C / Appendix C, structural form — §11 Phase 3a).
   *  When set, compose emits THESE messages for the frame instead of the source
   *  `messages`. The source stays authoritative for identity and for reconcile's
   *  refresh (which writes ONLY source), so the unaware agent's resend can never
   *  clobber a user's edit and `restore()`'s anchor recomputation never sees
   *  edited bytes — the Appendix C refresh-gate holds BY CONSTRUCTION, with no
   *  conditional in the matcher. null/undefined = no override (emit source).
   *  `tokenEstimate` always tracks the EMITTED representation
   *  (`representation ?? messages`). */
  representation?: WireMessage[] | null;

  /** Operation lineage (Phase 2): the ordered ids of the commits that produced this
   *  frame's current REPRESENTATION (e.g. ["c1"] after a delete, ["c1","c2"] after a
   *  revert). This is NOT the reconciliation source-identity index — that is anchorFp +
   *  occurrence above. Persisted so undo/audit survive restart; the general
   *  representation-override gate that reads it arrives in Phase 3 with edit/compact. */
  provenance: string[];

  /** The id of the `capture` event that first created this frame (Appendix C). Gives the
   *  frame a chronological origin in the timeline WITHOUT being a representation override
   *  — capture is source material arriving, not an operation, so it stays out of
   *  `provenance` and out of the refresh-gate. Null in the transient window before
   *  its creating event is recorded — and PERMANENTLY null for manufactured frames
   *  (origin added/combined/split): those are created by COMMITS, whose ids live in
   *  `provenance`; their timeline origin is the mirrored op event. */
  createdEventId: string | null;

  // Internal sequence numbers (NOT serialized into the request — kept off the wire
  // so they never perturb the deterministic byte stream).
  createdAt: number;
  modifiedAt: number;
}

/** Everything at the top level of a /v1/messages body except system/tools/messages.
 *  These are runtime knobs (model, max_tokens, temperature, stream, …) we preserve
 *  verbatim — full ownership of the prompt must not mean dropping these. */
export type RequestEnvelope = Record<string, unknown>;

/**
 * The per-request view (design.md §11 Phase 2.7 — fork isolation): the turn frames
 * THIS request's reconcile matched or appended, in incoming order, tombstone matches
 * INCLUDED. Compose-from-view emits exactly these frames minus tombstones (deleted
 * wins), so frames another request forked into the store — suggestion/recap side
 * queries that share the conversation key — never ride along on this wire body.
 *
 * "Scope emission, not matching": reconcile still matches against the FULL store
 * (tombstones included), so the delete-then-unaware-resend story is unchanged; the
 * view only scopes what compose EMITS. The request supplies MEMBERSHIP + baseline
 * order; the store supplies each member's REPRESENTATION (future ops transform it).
 * Views are derived per request and never persisted.
 */
export interface RequestView {
  /** Ordered: one id per incoming turn frame — the matched existing frame
   *  (tombstone matches included) or the freshly appended one. */
  frameIds: string[];
  /** The view's capture target: the last NON-DELETED turn frame OF THE VIEW — not
   *  the store tail. A fork's reply must land on the fork's own open frame, never
   *  on whatever frame happens to be last in the store. */
  openFrameId: string | null;
  /** Turn frames this request created. Deliberately decoupled from ingest()'s
   *  capture-EVENT bookkeeping, whose affected set may include the preamble — the
   *  preamble is head representation, never view membership. */
  createdIds: string[];
  /** Turn frames whose content materially grew this request (turn-only; same
   *  decoupling from the event's affected set as createdIds). */
  grownIds: string[];
}

/** A frame as carved out of one incoming request by decompose(). */
export interface DecomposedFrame {
  anchorFp: string;
  role: Role;
  messages: WireMessage[];
}
