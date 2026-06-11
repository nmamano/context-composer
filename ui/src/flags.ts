// Flag-chip mapping — PURE (the §8 unit boundary). One place decides how a
// FrameSummary's state fields become visible chips, so the frame view and any
// future surface agree.

import type { FrameSummary } from "../../src/engine/state.ts";

export interface FlagChip {
  key: string;
  label: string;
}

/** F-063 (plans/ui-feedback.md): position dropdowns (add / move / combine)
 *  offer only anchors worth picking — a DESTINATION-list filter, not op
 *  hiding (the F-006 distinction: card visibility ≠ op availability; ops are
 *  still never hidden by frame state, and the daemon's refusal still renders
 *  verbatim for anything else invalid). Excluded:
 *    - the preamble: the engine's anchor lookup covers turn frames only
 *      (state.ts add/move/combine all check `this.frames.some(...)`, which
 *      the preamble is not part of) — "after p0" can ONLY refuse;
 *    - deleted frames: Nil's report — anchoring after a tombstone fails;
 *    - fork-only frames (inLastView === false, strictly): hidden by default
 *      in the frame view and not part of the main thread (Nil: exclude).
 *  Absorbed parts / split originals STAY: they are valid anchors by design
 *  (F-047 plan: they keep their order-spine slot). */
export function positionAnchors(frames: FrameSummary[]): FrameSummary[] {
  return frames.filter(
    (f) => f.kind !== "preamble" && !f.deleted && f.inLastView !== false,
  );
}

export function frameFlags(f: FrameSummary): FlagChip[] {
  const chips: FlagChip[] = [];
  if (f.deleted) chips.push({ key: "deleted", label: "deleted" });
  if (f.offloaded) {
    // Offload implies a representation override (the stub IS the representation);
    // one chip carries both — "offloaded · override" would be noise.
    chips.push({ key: "offloaded", label: "offloaded" });
  } else if (f.overridden) {
    chips.push({ key: "override", label: "override" });
  }
  if (f.origin !== "captured") {
    chips.push({ key: `origin-${f.origin}`, label: f.origin });
  }
  if (f.absorbedInto) {
    chips.push({ key: "absorbed", label: `absorbed→${f.absorbedInto}` });
  }
  if (f.splitInto && f.splitInto.length > 0) {
    chips.push({ key: "split", label: `split→${f.splitInto.length}` });
  }
  // STRICTLY === false. null means NOT APPLICABLE — the preamble, a store with no
  // emitted view yet, or a manufactured frame (added/combined/split: never view
  // members, yet they emit via resolution; calling them fork-only would mislead —
  // the engine already nulls these, and we must not "default" null into a flag).
  if (f.inLastView === false) {
    chips.push({ key: "fork-only", label: "fork-only" });
  }
  return chips;
}
