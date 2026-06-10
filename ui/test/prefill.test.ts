// F-003 (plans/ui-feedback.md) — offload-form prefill is a PREVIEW of the
// engine's own default: deriveSummary (the engine's exported function) over the
// CURRENT EMISSION (representation ?? messages). The UI re-states, never
// re-decides — clearing the field omits the param and the daemon derives the
// identical value.

import { expect, test } from "bun:test";
import { opPrefill } from "../src/prefill.ts";
import { opByVerb } from "../../src/shared/ops.ts";
import type { Frame } from "../../src/engine/types.ts";

const frame = (extra: Partial<Frame> = {}): Frame => ({
  id: "f1",
  kind: "turn",
  role: "user",
  title: "frame f1",
  summary: null,
  anchorFp: "fp",
  occurrence: 0,
  messages: [
    { role: "user", content: "first line of the question\nsecond line" },
    { role: "assistant", content: "the answer" },
  ],
  stopReason: null,
  tokenEstimate: 42,
  deleted: false,
  origin: "captured",
  offloaded: false,
  fileReference: null,
  provenance: [],
  createdEventId: "e1",
  createdAt: 1,
  modifiedAt: 2,
  ...extra,
});

const offload = opByVerb("offload")!;

test("offload prefill mirrors the engine default: first text line of the emission", () => {
  expect(opPrefill(offload, [frame()])).toEqual({
    summary: "first line of the question",
  });
});

test("offload prefill reads the CURRENT emission — representation wins over source", () => {
  const f = frame({
    representation: [{ role: "user", content: "the override text" }],
  });
  expect(opPrefill(offload, [f])).toEqual({ summary: "the override text" });
});

test("offload prefill falls back to the engine's literal fallback when the emission has no text", () => {
  const f = frame({
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }],
      },
    ],
  });
  expect(opPrefill(offload, [f])).toEqual({ summary: "offloaded frame f1" });
});

test("other verbs prefill nothing", () => {
  for (const verb of ["edit", "retitle", "compact", "add"]) {
    expect(opPrefill(opByVerb(verb)!, [frame()])).toEqual({});
  }
});
