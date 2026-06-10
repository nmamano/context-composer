// §11 Phase 5c — history/timeline mapping (pure unit boundary).

import { describe, expect, test } from "bun:test";
import { commitRows, eventRows, renderValue } from "../src/history.ts";
import type { PublicCommit, PublicEvent } from "../src/api.ts";

const commit = (extra: Partial<PublicCommit> = {}): PublicCommit => ({
  id: "c1",
  type: "delete",
  affectedFrameIds: ["t1"],
  params: {},
  note: null,
  branchId: null,
  parentCommitId: null,
  timestamp: "2026-06-10T00:00:00Z",
  ...extra,
});

describe("renderValue (faithful + safe)", () => {
  test("strings verbatim, objects pretty JSON, never throws", () => {
    expect(renderValue("plain")).toBe("plain");
    expect(renderValue({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(renderValue(null)).toBe("null");
    expect(renderValue(undefined)).toBe(String(undefined));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic; // JSON.stringify throws — renderValue must not
    expect(typeof renderValue(cyclic)).toBe("string");
  });
});

describe("commitRows", () => {
  test("direct revert marking: target marked, revert commit stays a normal row", () => {
    const rows = commitRows([
      commit({ id: "c1", type: "retitle" }),
      commit({
        id: "c2",
        type: "revert",
        params: { revertedCommitId: "c1" },
      }),
    ]);
    expect(rows.find((r) => r.id === "c1")!.reverted).toBe(true);
    const revertRow = rows.find((r) => r.id === "c2")!;
    expect(revertRow.reverted).toBe(false);
    expect(revertRow.type).toBe("revert");
  });

  test("revert pointing at an unknown target renders as data, no throw, marks nothing", () => {
    const rows = commitRows([
      commit({ id: "c1" }),
      commit({ id: "c2", type: "revert", params: { revertedCommitId: "ghost" } }),
    ]);
    expect(rows.every((r) => !r.reverted)).toBe(true);
  });

  test("before/after params become the two-column diff; rest become paramsText", () => {
    const rows = commitRows([
      commit({
        id: "c3",
        type: "edit",
        params: {
          before: null,
          after: [{ role: "user", content: "new" }],
          other: "kept",
        },
      }),
    ]);
    const r = rows[0]!;
    expect(r.diff).not.toBeNull();
    expect(r.diff!.before).toBe("null");
    expect(r.diff!.after).toContain('"content": "new"');
    expect(r.paramsText).toContain('"other": "kept"');
  });

  test("no before/after → no diff; empty rest → no paramsText", () => {
    const r = commitRows([commit()])[0]!;
    expect(r.diff).toBeNull();
    expect(r.paramsText).toBeNull();
  });

  test("string before/after render verbatim (not JSON-quoted)", () => {
    const r = commitRows([
      commit({ params: { before: "old title", after: "new title" } }),
    ])[0]!;
    expect(r.diff).toEqual({ before: "old title", after: "new title" });
  });
});

describe("eventRows", () => {
  test("maps public events including null commitId (captures)", () => {
    const events: PublicEvent[] = [
      { id: "e1", type: "capture", frameIds: ["t1"], commitId: null, timestamp: "ts1", note: null },
      { id: "e2", type: "delete", frameIds: ["t1"], commitId: "c1", timestamp: "ts2", note: null },
    ];
    const rows = eventRows(events);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.commitId).toBeNull();
    expect(rows[1]!.commitId).toBe("c1");
  });
});
