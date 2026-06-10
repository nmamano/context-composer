// Details-panel field mapping — PURE (the §8 unit boundary): a full show()
// payload becomes an ordered list of label/value rows. Rendering stays dumb;
// WHAT is shown (and that source-vs-current is explicit) is decided here.

import type { Frame } from "../../src/engine/types.ts";

export interface DetailField {
  label: string;
  value: string;
}

export function detailsFields(f: Frame): DetailField[] {
  const rows: DetailField[] = [
    { label: "id", value: f.id },
    { label: "kind", value: f.kind },
    { label: "role", value: f.role },
    { label: "origin", value: f.origin },
    { label: "title", value: f.title },
  ];
  if (f.summary) rows.push({ label: "summary", value: f.summary });
  rows.push({ label: "tokens (emitted)", value: String(f.tokenEstimate) });
  rows.push({ label: "messages (source)", value: String(f.messages.length) });
  if (f.deleted) rows.push({ label: "deleted", value: "yes (tombstone — emits nothing)" });
  if (f.offloaded) rows.push({ label: "offloaded", value: "yes (emission is the stub)" });
  if (f.fileReference) rows.push({ label: "fileReference", value: f.fileReference });
  if (f.representation) {
    rows.push({
      label: "representation",
      value: `override in effect (${f.representation.length} message${f.representation.length === 1 ? "" : "s"})`,
    });
  }
  if (f.placement !== undefined && f.placement !== null) {
    rows.push({
      label: "placement",
      value: f.placement.after === null ? "at start" : `after ${f.placement.after}`,
    });
  }
  if (f.absorbedInto) rows.push({ label: "absorbed into", value: f.absorbedInto });
  if (f.splitInto && f.splitInto.length > 0) {
    rows.push({ label: "split into", value: f.splitInto.join(", ") });
  }
  if (f.stopReason !== undefined && f.stopReason !== null) {
    rows.push({ label: "stop reason", value: f.stopReason });
  }
  // §11 Phase 5b — strip/summarize take tool_use_ids of tool_result blocks in
  // the CURRENT EMISSION (representation ?? messages — what the store
  // transforms); surface them so the op form can be filled from here.
  const resultIds: string[] = [];
  for (const m of f.representation ?? f.messages) {
    if (typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        resultIds.push(b.tool_use_id);
      }
    }
  }
  if (resultIds.length > 0) {
    rows.push({ label: "tool_result ids (emission)", value: resultIds.join(", ") });
  }
  rows.push({
    label: "provenance",
    value: f.provenance.length > 0 ? f.provenance.join(" → ") : "(no ops yet)",
  });
  if (f.createdEventId) rows.push({ label: "created event", value: f.createdEventId });
  if (f.kind === "preamble") {
    if (f.system !== undefined) {
      rows.push({
        label: "system",
        value: typeof f.system === "string" ? f.system : `${f.system.length} block(s)`,
      });
    }
    if (f.tools) rows.push({ label: "tools", value: `${f.tools.length} definition(s)` });
    if (f.injectedSystem && f.injectedSystem.length > 0) {
      rows.push({ label: "injected system", value: `${f.injectedSystem.length} block(s)` });
    }
  }
  return rows;
}
