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

export function opPrefill(
  op: OpSpec,
  targets: Frame[],
  /** F-069: move's default needs the ENGINE's emission order (compose's
   *  emittedFrameIds — re-stated, never re-derived). */
  ctx?: { emittedFrameIds?: string[] },
): FormValues {
  if (targets.length !== 1) return {};
  const f = targets[0]!;
  if (op.verb === "move") {
    // F-069 (Nil): the dropdown defaults to the frame's CURRENT location —
    // its emission predecessor — so an accidental submit changes nothing
    // visible. Never default to the start (Nil's server-side concern); the
    // one exception is a frame ALREADY first, where keep-current IS start
    // and moving it there changes nothing. A target absent from the emission
    // (fork-only/deleted) defaults to the end (after the last emitted frame);
    // no order known → no default (the daemon's refusal speaks on submit).
    const order = ctx?.emittedFrameIds ?? [];
    const idx = order.indexOf(f.id);
    if (idx > 0) return { after: order[idx - 1]! };
    if (idx === 0) return { after: "start" };
    const last = order[order.length - 1];
    return last !== undefined ? { after: last } : {};
  }
  if (op.verb === "offload") {
    // Mirrors state.ts offload() (F-017): opts.summary ?? f.summary (the
    // ingest-enrichment auto-summary) ?? deriveSummary(emission) ?? fallback.
    return {
      summary:
        f.summary ?? deriveSummary(currentEmission(f)) ?? `offloaded frame ${f.id}`,
    };
  }
  if (op.verb === "compact") {
    // F-061 (Nil: "the LLM summary is generated automatically, and
    // optionally the user can edit it. Note: the offloading op does this
    // correctly."): compact's text opens with the same chain offload uses —
    // the frame's auto-summary, else the engine's deterministic first-line
    // derive. UNLIKE offload this is a STARTING VALUE per Nil's standing
    // prefill principle (F-066), not an engine-default preview: compact has
    // no server-side text default (clearing the box and submitting lets the
    // daemon's refusal speak). No literal fallback — offload's
    // "offloaded frame <id>" belongs to offload alone.
    const text = f.summary ?? deriveSummary(currentEmission(f));
    return text !== null ? { text } : {};
  }
  // F-060's whole-frame edit prefill is gone WITH the menu edit form (F-068:
  // editing moved to the details panel, per message — see transcript.ts
  // editableMessageText/replaceMessageText, which carry the same faithfulness
  // bar at message level).
  return {};
}
