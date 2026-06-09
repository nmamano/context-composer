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
   *  omits it. Recoverable later via Phase 2 `revert`. */
  deleted: boolean;

  // Internal sequence numbers (NOT serialized into the request — kept off the wire
  // so they never perturb the deterministic byte stream).
  createdAt: number;
  modifiedAt: number;
}

/** Everything at the top level of a /v1/messages body except system/tools/messages.
 *  These are runtime knobs (model, max_tokens, temperature, stream, …) we preserve
 *  verbatim — full ownership of the prompt must not mean dropping these. */
export type RequestEnvelope = Record<string, unknown>;

/** A frame as carved out of one incoming request by decompose(). */
export interface DecomposedFrame {
  anchorFp: string;
  role: Role;
  messages: WireMessage[];
}
