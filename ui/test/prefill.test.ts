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

test("F-017: the frame's own summary (ingest enrichment) beats the derived first line", () => {
  expect(opPrefill(offload, [frame({ summary: "what this turn was about" })])).toEqual({
    summary: "what this turn was about",
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
  for (const verb of ["retitle", "add", "delete", "move", "split"]) {
    expect(opPrefill(opByVerb(verb)!, [frame()])).toEqual({});
  }
});

// --- F-061: compact opens with the offload chain (auto-summary ?? derive) ----

const compact = opByVerb("compact")!;

test("F-061: compact prefills text from the frame's auto-summary when present", () => {
  expect(opPrefill(compact, [frame({ summary: "what this turn was about" })])).toEqual({
    text: "what this turn was about",
  });
});

test("F-061: compact falls back to the engine's deterministic derive over the CURRENT emission", () => {
  expect(opPrefill(compact, [frame()])).toEqual({
    text: "first line of the question",
  });
  const overridden = frame({
    representation: [{ role: "user", content: "the override text" }],
  });
  expect(opPrefill(compact, [overridden])).toEqual({ text: "the override text" });
});

test("F-061: compact prefills NOTHING when no summary is derivable — no borrowed offload literal", () => {
  const f = frame({
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", name: "Bash", input: {} }],
      },
    ],
  });
  expect(opPrefill(compact, [f])).toEqual({});
});

// --- F-060 → F-068: whole-frame edit prefill is GONE with the menu edit form.
// The message-level faithfulness rules live in transcript.ts
// (editableMessageText / replaceMessageText) and are pinned in
// transcript.test.ts; the panel flow is pinned in op-menu.test.tsx.

test("edit (panel-relocated) and other verbs prefill nothing", () => {
  for (const verb of ["edit", "retitle"]) {
    expect(opPrefill(opByVerb(verb)!, [frame()])).toEqual({});
  }
});

// --- F-069: move's dropdown defaults to the frame's CURRENT location --------

const move = opByVerb("move")!;

test("F-069: move prefills the emission predecessor (keep current position)", () => {
  expect(
    opPrefill(move, [frame({ id: "f2" })], { emittedFrameIds: ["f1", "f2", "f3"] }),
  ).toEqual({ after: "f1" });
});

test("F-069: a frame already FIRST keeps current = start (the one allowed start default — a no-op)", () => {
  expect(
    opPrefill(move, [frame({ id: "f1" })], { emittedFrameIds: ["f1", "f2"] }),
  ).toEqual({ after: "start" });
});

test("F-069: a target absent from the emission (fork-only/deleted) defaults to the END", () => {
  expect(
    opPrefill(move, [frame({ id: "f9" })], { emittedFrameIds: ["f1", "f2"] }),
  ).toEqual({ after: "f2" });
});

test("F-069: no emission order known → no default (the daemon's refusal speaks)", () => {
  expect(opPrefill(move, [frame({ id: "f1" })])).toEqual({});
  expect(opPrefill(move, [frame({ id: "f1" })], { emittedFrameIds: [] })).toEqual({});
});
