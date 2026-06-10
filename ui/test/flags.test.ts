// §11 Phase 5a — flag-chip mapping (pure unit boundary, reviewer point 5).

import { expect, test } from "bun:test";
import { frameFlags } from "../src/flags.ts";
import type { FrameSummary } from "../../src/engine/state.ts";

const summary = (extra: Partial<FrameSummary> = {}): FrameSummary => ({
  id: "f1",
  kind: "turn",
  role: "user",
  title: "frame f1",
  summary: null,
  tokenEstimate: 10,
  deleted: false,
  messageCount: 2,
  overridden: false,
  offloaded: false,
  fileReference: null,
  origin: "captured",
  absorbedInto: null,
  splitInto: null,
  inLastView: true,
  ...extra,
});

const keys = (f: FrameSummary) => frameFlags(f).map((c) => c.key);

test("clean captured in-view frame has no chips", () => {
  expect(keys(summary())).toEqual([]);
});

test("deleted / override / offloaded chips", () => {
  expect(keys(summary({ deleted: true }))).toEqual(["deleted"]);
  expect(keys(summary({ overridden: true }))).toEqual(["override"]);
  // Offload implies a representation override — ONE chip, not two.
  expect(
    keys(summary({ offloaded: true, overridden: true, fileReference: "/tmp/f.md" })),
  ).toEqual(["offloaded"]);
});

test("fork-only requires inLastView STRICTLY false (null is not a flag)", () => {
  expect(keys(summary({ inLastView: false }))).toEqual(["fork-only"]);
  // null = not applicable (preamble / no view yet / manufactured) — NO chip.
  expect(keys(summary({ inLastView: null }))).toEqual([]);
  expect(keys(summary({ kind: "preamble", inLastView: null }))).toEqual([]);
});

test("manufactured origins are labeled by origin, never mislabeled fork-only", () => {
  // The engine nulls inLastView for manufactured frames (state.ts summarize);
  // the chip mapping must not turn that null into fork-only.
  expect(keys(summary({ origin: "added", inLastView: null }))).toEqual([
    "origin-added",
  ]);
  expect(keys(summary({ origin: "combined", inLastView: null }))).toEqual([
    "origin-combined",
  ]);
  expect(keys(summary({ origin: "split", inLastView: null }))).toEqual([
    "origin-split",
  ]);
});

test("structural state chips: absorbed part and split original", () => {
  expect(keys(summary({ absorbedInto: "f9" }))).toEqual(["absorbed"]);
  expect(frameFlags(summary({ absorbedInto: "f9" }))[0]!.label).toBe("absorbed→f9");
  expect(keys(summary({ splitInto: ["fa", "fb"] }))).toEqual(["split"]);
  expect(frameFlags(summary({ splitInto: ["fa", "fb"] }))[0]!.label).toBe("split→2");
});

test("combinations stack in stable order", () => {
  expect(
    keys(summary({ deleted: true, overridden: true, inLastView: false })),
  ).toEqual(["deleted", "override", "fork-only"]);
});
