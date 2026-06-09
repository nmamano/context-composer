// Reconciliation (design decision A; the load-bearing Phase 1 unknown).
//
// Each turn the *unaware* wrapped agent resends its full transcript — including
// frames we deleted, edited, or compacted. Reconcile maps that incoming view onto
// our authoritative frame state WITHOUT being naively append-only. The key is the
// negative-match set: a deleted frame keeps a tombstone, reconcile MATCHES the
// resent content to it, and the tombstone wins (content ignored, frame stays
// omitted from compose). Without this, the agent's resend re-introduces deleted
// context as a "new" frame and the deletion silently undoes itself.
//
// Matching is greedy and ordered: walk incoming frames left-to-right, binding each
// to the first not-yet-consumed existing frame with the same opening fingerprint
// at/after a moving pointer. This disambiguates duplicate fingerprints by order
// (the documented duplicate-message limitation — see fingerprint.ts). New content
// (always at the tail, since the agent appends) has no match and is appended.

import type { DecomposedFrame, Frame, WireMessage } from "./types.ts";

export interface ReconcileDeps {
  /** Build a fresh authoritative frame for an unmatched incoming frame. */
  makeFrame: (inc: DecomposedFrame) => Frame;
  estimate: (messages: WireMessage[]) => number;
  nextSeq: () => number;
}

export function reconcile(
  existing: Frame[],
  incoming: DecomposedFrame[],
  deps: ReconcileDeps,
): Frame[] {
  const consumed = new Set<number>();
  let pointer = 0; // existing frames at/after here are still matchable in order
  // Only frames present BEFORE this pass are matchable. Frames appended during this
  // pass (new tail content) must not be matched by a later duplicate in the same
  // request — otherwise two identical incoming messages collapse into one frame.
  const matchable = existing.length;

  for (const inc of incoming) {
    let matchIdx = -1;
    for (let i = pointer; i < matchable; i++) {
      if (!consumed.has(i) && existing[i]!.anchorFp === inc.anchorFp) {
        matchIdx = i;
        break;
      }
    }

    if (matchIdx >= 0) {
      consumed.add(matchIdx);
      pointer = matchIdx + 1;
      const frame = existing[matchIdx]!;
      if (!frame.deleted) {
        // Live frame may have GROWN (assistant reply / tool-loop continuation).
        // Refresh content from the authoritative resend; identity (anchorFp) is
        // unchanged because the opening message is unchanged.
        frame.messages = inc.messages;
        frame.tokenEstimate = deps.estimate(inc.messages);
        frame.modifiedAt = deps.nextSeq();
      }
      // Tombstone branch: ignore resent content; the frame stays deleted/omitted.
    } else {
      existing.push(deps.makeFrame(inc));
    }
  }

  return existing;
}
