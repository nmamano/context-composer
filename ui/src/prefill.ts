// Op-form prefill — PURE (the §8 unit boundary). F-003 (plans/ui-feedback.md):
// the offload form opens with the stub summary ready instead of empty.
//
// Thin-wrapper discipline: the prefilled value is a PREVIEW of the engine's own
// default, computed with the ENGINE'S exported function (deriveSummary — no
// re-implementation, no drift; offload.ts is pure/browser-safe). The user may
// edit it; clearing the field omits the param and the daemon derives the
// identical value. The UI still decides nothing.

import type { Frame } from "../../src/engine/types.ts";
import type { OpSpec } from "../../src/shared/ops.ts";
import { deriveSummary } from "../../src/engine/offload.ts";
import { currentEmission } from "./transcript.ts";
import type { FormValues } from "./components/OpMenu.tsx";

export function opPrefill(op: OpSpec, targets: Frame[]): FormValues {
  if (op.verb === "offload" && targets.length === 1) {
    const f = targets[0]!;
    // Mirrors state.ts offload(): summary ?? deriveSummary(emission) ?? fallback.
    return {
      summary: deriveSummary(currentEmission(f)) ?? `offloaded frame ${f.id}`,
    };
  }
  return {};
}
