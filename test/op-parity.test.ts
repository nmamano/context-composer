// §11 Phase 5b — the MECHANICAL CLI-parity gate (design.md §11 Phase 5: the UI
// surfaces no operation lacking a CLI verb, verified by diffing lists, not by
// principle). Three locks:
//   1. registry mutating verbs ≡ CLI mutating verbs (both directions),
//   2. read-only CLI verbs stay OUT of the op registry (they are views, not
//      menu ops — documented exclusion, asserted),
//   3. every registry spec is wire-honest: a /control route the server owns,
//      and build() produces the route's body shape for representative inputs.
// The CLI dispatch table itself is keyed by the exported verb union (a type
// error if they drift), so importing the constants here is importing the truth.

import { describe, expect, test } from "bun:test";
import { CTX_MUTATING_VERBS, CTX_READONLY_VERBS } from "../src/cli/ctx.ts";
import { OP_REGISTRY, opByVerb } from "../src/shared/ops.ts";

describe("UI/CLI parity (both directions)", () => {
  test("every registry op has a CLI mutating verb", () => {
    const cli = new Set<string>(CTX_MUTATING_VERBS);
    for (const op of OP_REGISTRY) {
      expect(cli.has(op.verb)).toBe(true);
    }
  });

  test("every CLI mutating verb is in the registry — none missing, none extra", () => {
    const registry = [...OP_REGISTRY.map((o) => o.verb)].sort();
    const cli = [...CTX_MUTATING_VERBS].sort();
    expect(registry).toEqual(cli);
  });

  test("read-only CLI verbs are exactly the documented non-menu surface", () => {
    // Views, not ops: list/show feed the panes, compose is the ordering oracle,
    // history/timeline are the 5c panel, conversations is the switcher.
    expect([...(CTX_READONLY_VERBS as readonly string[])].sort()).toEqual(
      ["compose", "conversations", "history", "list", "show", "timeline"].sort(),
    );
    for (const verb of CTX_READONLY_VERBS) {
      expect(opByVerb(verb)).toBeUndefined();
    }
  });

  test("no verb is both mutating and read-only", () => {
    const ro = new Set<string>(CTX_READONLY_VERBS);
    for (const v of CTX_MUTATING_VERBS) expect(ro.has(v)).toBe(false);
  });
});

describe("registry wire-honesty", () => {
  test("every route is an owned /control route and arity is valid", () => {
    for (const op of OP_REGISTRY) {
      expect(op.route).toBe(`/control/${op.verb}`);
      expect(["none", "single", "multi"]).toContain(op.arity);
    }
  });

  test("build() produces the server's body shape (representative cases)", () => {
    expect(opByVerb("delete")!.build(["f1"], {})).toEqual({ ids: ["f1"] });
    expect(opByVerb("edit")!.build(["f1"], { text: "new" })).toEqual({
      id: "f1",
      text: "new",
    });
    expect(opByVerb("compact")!.build(["f1"], { regen: true })).toEqual({
      id: "f1",
      regen: true,
    });
    expect(opByVerb("offload")!.build(["f1"], {})).toEqual({ id: "f1" });
    expect(opByVerb("offload")!.build(["f1"], { summary: "s" })).toEqual({
      id: "f1",
      summary: "s",
    });
    expect(opByVerb("restore")!.build(["f1"], {})).toEqual({ id: "f1" });
    // add: explicit position mapping — start → null, end → omitted, id → id.
    expect(opByVerb("add")!.build([], { text: "t", after: "start" })).toEqual({
      text: "t",
      after: null,
    });
    expect(opByVerb("add")!.build([], { text: "t", after: "end" })).toEqual({
      text: "t",
    });
    expect(opByVerb("add")!.build([], { text: "t", after: "f2" })).toEqual({
      text: "t",
      after: "f2",
    });
    expect(opByVerb("move")!.build(["f1"], { after: "start" })).toEqual({
      id: "f1",
      after: null,
    });
    expect(opByVerb("move")!.build(["f1"], { after: "f2" })).toEqual({
      id: "f1",
      after: "f2",
    });
    // move with empty position omits `after` — the daemon's refusal speaks.
    expect(opByVerb("move")!.build(["f1"], {})).toEqual({ id: "f1" });
    expect(opByVerb("combine")!.build(["f1", "f2"], {})).toEqual({
      ids: ["f1", "f2"],
    });
    // split passes numbers through unjudged (invalid boundaries must reach the
    // daemon so refusal rendering is exercisable).
    expect(opByVerb("split")!.build(["f1"], { at: "1, 3" })).toEqual({
      id: "f1",
      at: [1, 3],
    });
    expect(opByVerb("split")!.build(["f1"], { at: "99" })).toEqual({
      id: "f1",
      at: [99],
    });
    expect(opByVerb("strip")!.build(["f1"], { all: true })).toEqual({
      id: "f1",
      all: true,
    });
    expect(opByVerb("strip")!.build(["f1"], { resultIds: "tu_1, tu_2" })).toEqual({
      id: "f1",
      resultIds: ["tu_1", "tu_2"],
    });
    expect(
      opByVerb("summarize")!.build(["f1"], { all: true, text: "s" }),
    ).toEqual({ id: "f1", all: true, text: "s" });
    expect(
      opByVerb("retitle")!.build(["f1"], { title: "T", summary: "S" }),
    ).toEqual({ id: "f1", title: "T", summary: "S" });
    expect(opByVerb("retitle")!.build(["f1"], { regen: true })).toEqual({
      id: "f1",
      regen: true,
    });
    // revert: {} reverts HEAD (5b topbar); a PROGRAMMATIC commit value targets
    // a specific commit (5c history panel) — params stays [] so no form opens.
    expect(opByVerb("revert")!.build([], {})).toEqual({});
    expect(opByVerb("revert")!.build([], { commit: "c7" })).toEqual({
      commit: "c7",
    });
    expect(opByVerb("revert")!.params).toEqual([]);
  });

  test("registry is pure data — no DOM/React/fetch reachable from import", () => {
    // The import at the top succeeded under bun:test with no DOM registered;
    // assert the specs are plain serializable data + functions.
    for (const op of OP_REGISTRY) {
      expect(typeof op.verb).toBe("string");
      expect(typeof op.build).toBe("function");
      for (const p of op.params) {
        expect(["text", "textarea", "flag", "position", "indices", "ids"]).toContain(
          p.kind,
        );
      }
    }
  });
});
