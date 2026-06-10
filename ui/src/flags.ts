// Flag-chip mapping — PURE (the §8 unit boundary). One place decides how a
// FrameSummary's state fields become visible chips, so the frame view and any
// future surface agree.

import type { FrameSummary } from "../../src/engine/state.ts";

export interface FlagChip {
  key: string;
  label: string;
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
