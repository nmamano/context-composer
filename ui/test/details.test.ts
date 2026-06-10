// §11 Phase 5a — details-panel field mapping (pure unit boundary, reviewer
// point 5). The mapping must be explicit about source vs current emission and
// expose offload material as fileReference + stored frame content (never
// claiming the artifact bytes — no file-read API exists in 5a).

import { expect, test } from "bun:test";
import { detailsFields } from "../src/details.ts";
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
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
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

const byLabel = (f: Frame) =>
  new Map(detailsFields(f).map((r) => [r.label, r.value]));

test("baseline fields for a clean captured turn", () => {
  const rows = byLabel(frame());
  expect(rows.get("id")).toBe("f1");
  expect(rows.get("kind")).toBe("turn");
  expect(rows.get("origin")).toBe("captured");
  expect(rows.get("tokens (emitted)")).toBe("42");
  expect(rows.get("messages (source)")).toBe("2");
  expect(rows.get("provenance")).toBe("(no ops yet)");
  expect(rows.get("created event")).toBe("e1");
  // Absent-state rows don't appear at all.
  expect(rows.has("deleted")).toBe(false);
  expect(rows.has("offloaded")).toBe(false);
  expect(rows.has("fileReference")).toBe(false);
  expect(rows.has("representation")).toBe(false);
});

test("offloaded frame: stub semantics + fileReference path (not artifact bytes)", () => {
  const rows = byLabel(
    frame({
      offloaded: true,
      fileReference: "/tmp/frames/f1-abc.md",
      representation: [{ role: "user", content: "[offloaded] see file" }],
      provenance: ["c3"],
    }),
  );
  expect(rows.get("offloaded")).toContain("stub");
  expect(rows.get("fileReference")).toBe("/tmp/frames/f1-abc.md");
  expect(rows.get("representation")).toBe("override in effect (1 message)");
  expect(rows.get("provenance")).toBe("c3");
});

test("tombstone + placement + structural fields", () => {
  const rows = byLabel(
    frame({
      deleted: true,
      placement: { after: null },
      absorbedInto: "f7",
      splitInto: ["fa", "fb"],
      provenance: ["c1", "c2"],
    }),
  );
  expect(rows.get("deleted")).toContain("tombstone");
  expect(rows.get("placement")).toBe("at start");
  expect(rows.get("absorbed into")).toBe("f7");
  expect(rows.get("split into")).toBe("fa, fb");
  expect(rows.get("provenance")).toBe("c1 → c2");
});

// F-016 (plans/ui-feedback.md): same-name fields keep their relative position
// across frames — always-present fields lead in a fixed block, sometimes-present
// fields follow in a fixed relative order.
test("F-016: always-present fields precede sometimes-present; shared order is stable across frames", () => {
  const labels = (f: Frame) => detailsFields(f).map((r) => r.label);
  const plain = labels(frame());
  const flagged = labels(
    frame({
      summary: "a stub",
      deleted: true,
      offloaded: true,
      fileReference: "/tmp/x.md",
      representation: [{ role: "user", content: "stub" }],
      placement: { after: null },
      stopReason: "end_turn",
    }),
  );
  // Fixed lead block, identical on both frames.
  expect(plain.slice(0, 4)).toEqual(["id", "role", "title", "tokens (emitted)"]);
  expect(flagged.slice(0, 4)).toEqual(["id", "role", "title", "tokens (emitted)"]);
  // Labels common to both frames appear in the SAME relative order.
  const shared = plain.filter((l) => flagged.includes(l));
  expect(flagged.filter((l) => shared.includes(l))).toEqual(shared);
});

// F-015: tier mapping — the beginner subset (core) is what the panel shows by
// default; structural/audit fields are advanced.
test("F-015: state fields that change the emission are core; audit fields are advanced", () => {
  const tiers = new Map(
    detailsFields(
      frame({ offloaded: true, fileReference: "/tmp/x.md", deleted: true }),
    ).map((r) => [r.label, r.tier]),
  );
  for (const core of ["id", "role", "title", "tokens (emitted)", "deleted", "offloaded", "fileReference"]) {
    expect(tiers.get(core)).toBe("core");
  }
  for (const adv of ["kind", "origin", "messages (source)", "provenance", "created event"]) {
    expect(tiers.get(adv)).toBe("advanced");
  }
});

test("preamble exposes system/tools/injectedSystem", () => {
  const rows = byLabel(
    frame({
      kind: "preamble",
      role: "system",
      messages: [],
      system: "You are an agent",
      tools: [{ name: "Bash" }, { name: "Read" }],
      injectedSystem: [{ type: "text", text: "ctx" }],
      createdEventId: null,
    }),
  );
  expect(rows.get("system")).toBe("You are an agent");
  expect(rows.get("tools")).toBe("2 definition(s)");
  expect(rows.get("injected system")).toBe("1 block(s)");
  expect(rows.has("created event")).toBe(false);
});
