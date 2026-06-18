// Details-panel field mapping — PURE (the §8 unit boundary): a full show()
// payload becomes an ordered list of label/value rows. Rendering stays dumb;
// WHAT is shown (and that source-vs-current is explicit) is decided here.
//
// F-015/F-016 (plans/ui-feedback.md): every row carries a tier — "core" is the
// beginner-friendly default subset, "advanced" sits behind the panel's
// show-all toggle. Within each tier ALWAYS-present fields come first in a
// fixed order and SOMETIMES-present fields follow in a fixed relative order,
// so a field with the same name never moves between frames.

import type { Frame } from "../../src/engine/types.ts";

export interface DetailField {
  label: string;
  value: string;
  tier: "core" | "advanced";
}

export function detailsFields(f: Frame): DetailField[] {
  const core = (label: string, value: string): DetailField => ({
    label,
    value,
    tier: "core",
  });
  const adv = (label: string, value: string): DetailField => ({
    label,
    value,
    tier: "advanced",
  });

  // -- core, always present (fixed lead block) --------------------------------
  const rows: DetailField[] = [
    core("id", f.id),
    core("role", f.role),
    core("title", f.title),
    core("tokens (emitted)", String(f.tokenEstimate)),
  ];
  // -- core, sometimes present (fixed relative order): the state fields that
  //    change what the model sees — a beginner needs these to read the frame.
  if (f.summary) rows.push(core("summary", f.summary));
  if (f.deleted) rows.push(core("deleted", "yes (tombstone — emits nothing)"));
  if (f.offloaded) rows.push(core("offloaded", "yes (emission is the stub)"));
  if (f.fileReference) rows.push(core("fileReference", f.fileReference));
  if (f.representation) {
    rows.push(
      core(
        "representation",
        `override in effect (${f.representation.length} message${f.representation.length === 1 ? "" : "s"})`,
      ),
    );
  }

  // -- advanced, always present ------------------------------------------------
  rows.push(adv("kind", f.kind));
  rows.push(adv("origin", f.origin));
  rows.push(adv("messages (source)", String(f.messages.length)));
  rows.push(
    adv(
      "provenance",
      f.provenance.length > 0 ? f.provenance.join(" → ") : "(no ops yet)",
    ),
  );

  // -- advanced, sometimes present (fixed relative order) -----------------------
  if (f.placement !== undefined && f.placement !== null) {
    rows.push(
      adv(
        "placement",
        f.placement.after === null ? "at start" : `after ${f.placement.after}`,
      ),
    );
  }
  if (f.absorbedInto) rows.push(adv("absorbed into", f.absorbedInto));
  if (f.splitInto && f.splitInto.length > 0) {
    rows.push(adv("split into", f.splitInto.join(", ")));
  }
  if (f.stopReason !== undefined && f.stopReason !== null) {
    rows.push(adv("stop reason", f.stopReason));
  }
  // §11 Phase 5b — drop-results/summarize-results take tool_use_ids of tool_result blocks in
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
    rows.push(adv("tool_result ids (emission)", resultIds.join(", ")));
  }
  if (f.createdEventId) rows.push(adv("created event", f.createdEventId));
  if (f.kind === "preamble") {
    if (f.system !== undefined) {
      rows.push(
        adv(
          "system",
          typeof f.system === "string" ? f.system : `${f.system.length} block(s)`,
        ),
      );
    }
    if (f.tools) rows.push(adv("tools", `${f.tools.length} definition(s)`));
    if (f.injectedSystem && f.injectedSystem.length > 0) {
      rows.push(adv("injected system", `${f.injectedSystem.length} block(s)`));
    }
  }
  return rows;
}
