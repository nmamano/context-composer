// §11 Phase 3a acceptance — the §5.F STRUCTURAL SWEEP. Free editing can leave
// the resolved payload provider-invalid; compose must emit a valid request
// unconditionally — the single place that guarantees validity, so no individual
// op needs guard rails. Boundary (locked, 2.6 evidence rule): structural grammar
// only (tool pairing + role ordering), loudly surfaced via wireRepairs; facial
// content suspicion (thinking husks) stays detect-only. The store loses nothing —
// repairs are projection-time.

import { expect, test } from "bun:test";
import { sweepWire } from "../src/engine/wire-integrity.ts";
import { FrameStore } from "../src/engine/state.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";
import type { WireMessage } from "../src/engine/types.ts";

const HEAD = { model: "m", max_tokens: 64, system: "SYS" };

// ── unit: each repair kind ────────────────────────────────────────────────────

test("orphaned tool_use (no tool_result anywhere after) is dropped and surfaced", () => {
  const { messages, repairs } = sweepWire([
    { role: "user", content: "do it" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "tuX", name: "Read", input: {} },
      ],
    },
  ]);
  expect(JSON.stringify(messages)).not.toContain("tuX");
  expect(JSON.stringify(messages)).toContain("calling"); // only the orphan block dropped
  expect(repairs).toEqual([
    { kind: "orphan-tool-use", detail: expect.stringContaining("tuX") },
  ]);
});

test("orphaned tool_result (no preceding tool_use) is dropped; empty husk message goes too", () => {
  const { messages, repairs } = sweepWire([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "ghost", content: "boo" }] },
    { role: "user", content: "real question" },
  ]);
  expect(JSON.stringify(messages)).not.toContain("ghost");
  const kinds = repairs.map((r) => r.kind);
  expect(kinds).toContain("orphan-tool-result");
  expect(kinds).toContain("empty-message"); // the tool_result-only message emptied out
  // The two surviving user messages merge into a legal alternation…
  expect(messages[messages.length - 1]!.role).toBe("user");
});

test("a tool_result whose tool_use comes only LATER is an orphan (order matters)", () => {
  const { messages, repairs } = sweepWire([
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "early" }, { type: "text", text: "and a question" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "late" }] },
  ]);
  // The early result is orphaned (no preceding use); the use+late pair survives.
  expect(JSON.stringify(messages)).not.toContain("early");
  expect(JSON.stringify(messages)).toContain("late");
  expect(repairs.map((r) => r.kind)).toContain("orphan-tool-result");
});

test("leading assistant messages are dropped; adjacent same-role runs merge non-lossily", () => {
  const { messages, repairs } = sweepWire([
    { role: "assistant", content: "I should not open the conversation" },
    { role: "user", content: "first" },
    { role: "user", content: [{ type: "text", text: "second" }] },
    { role: "assistant", content: "reply" },
  ]);
  expect(messages).toHaveLength(2);
  expect(messages[0]!.role).toBe("user");
  // Non-lossy merge: both user contents present, normalized to blocks.
  expect(JSON.stringify(messages[0])).toContain("first");
  expect(JSON.stringify(messages[0])).toContain("second");
  const kinds = repairs.map((r) => r.kind);
  expect(kinds).toContain("leading-assistant");
  expect(kinds).toContain("merged-same-role");
});

// Reviewer-caught correctness hole in the first sweep draft: a global id-set
// lookup kept a tool_use alive because SOME result with that id existed — even
// when that result appeared EARLIER and was itself dropped as an orphan. The
// pairing must be sequential: retention depends on a SURVIVING later result.
test("a tool_use whose only result came earlier (and was dropped) is also dropped", () => {
  const { messages, repairs } = sweepWire([
    { role: "user", content: "start" }, // ordinary opener so leading-assistant can't mask it
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "early" },
        { type: "text", text: "question" },
      ],
    },
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }] },
  ]);
  const w = JSON.stringify(messages);
  expect(w).not.toContain("tool_result");
  expect(w).not.toContain("tool_use"); // BOTH halves gone — no orphan survives
  expect(w).toContain("question");
  const kinds = repairs.map((r) => r.kind);
  expect(kinds).toContain("orphan-tool-result");
  expect(kinds).toContain("orphan-tool-use");
  expect(kinds).toContain("empty-message"); // the emptied assistant message
});

test("a valid conversation passes through untouched — same array, zero repairs", () => {
  const valid: WireMessage[] = [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu1", name: "Read", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "data" }] },
    { role: "assistant", content: "a" },
  ];
  const { messages, repairs } = sweepWire(valid);
  expect(repairs).toEqual([]);
  expect(messages).toBe(valid); // byte-stability: untouched input returns as-is
});

// ── e2e: a raw edit induces invalidity; compose emits valid + surfaces repairs ─

test("raw edit dropping a tool_result: compose sweeps the orphaned tool_use and surfaces it", () => {
  const s = new FrameStore(null);
  // A frame with a full tool loop.
  s.ingest({
    ...HEAD,
    messages: [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tuA", name: "Read", input: { path: "x" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tuA", content: "contents" }] },
      { role: "assistant", content: "done" },
    ],
  });

  // The user, with full authorship, strips the tool_result out of the emission
  // but keeps the tool_use — an intermediate state edit must be ALLOWED to make.
  const r = s.edit("t1", {
    raw: [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I read it" },
          { type: "tool_use", id: "tuA", name: "Read", input: { path: "x" } },
        ],
      },
    ],
  });
  expect(r.ok).toBe(true);

  const c = s.compose();
  const w = JSON.stringify(c.body);
  expect(w).not.toContain("tuA"); // orphan swept off the wire
  expect(w).toContain("I read it"); // the rest of the edit emitted
  expect(c.wireRepairs.map((x) => x.kind)).toEqual(["orphan-tool-use"]);
  // The store still holds BOTH the source loop and the user's raw edit (zero loss).
  expect(JSON.stringify(s.show("t1")!.messages)).toContain("contents");
  expect(JSON.stringify(s.show("t1")!.representation)).toContain("tuA");
});

test("through the proxy: repairs ride the wiretap and the control compose surface", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cc-sweep-"));
  const tapPath = join(dir, "tap.jsonl");
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, wiretapPath: tapPath });
    const base = `http://localhost:${proxy.port}`;

    stub.enqueue({ text: "r1", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...HEAD, messages: [{ role: "user", content: "hello" }] }),
    })).text();
    await fetch(`${base}/control/list`);

    // Induce an orphan via raw edit, then check the control compose surface…
    await fetch(`${base}/control/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "t1",
        raw: [
          { role: "user", content: "hello" },
          { role: "assistant", content: [{ type: "tool_use", id: "tuZ", name: "X", input: {} }] },
        ],
      }),
    });
    const c = (await (await fetch(`${base}/control/compose?dump`)).json()) as any;
    // Dropping the orphan empties the assistant message, which is then dropped
    // too — both repairs surfaced.
    expect(c.wireRepairs.map((x: any) => x.kind)).toEqual(["orphan-tool-use", "empty-message"]);
    expect(JSON.stringify(c.body)).not.toContain("tuZ");

    // …and the wiretap entry for the next owned request.
    stub.enqueue({ text: "r2", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...HEAD,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "r1" },
          { role: "user", content: "again" },
        ],
      }),
    })).text();
    await fetch(`${base}/control/list`);

    const lines = readFileSync(tapPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const owned = lines.filter((e) => e.kind === "messages");
    const last = owned[owned.length - 1]!;
    // Full cascade on the live request: orphan dropped → assistant emptied →
    // the two adjacent user messages merge back into a legal alternation.
    expect(last.wireRepairs.map((x: any) => x.kind)).toEqual([
      "orphan-tool-use",
      "empty-message",
      "merged-same-role",
    ]);
    expect(JSON.stringify(last.outboundBody)).not.toContain("tuZ");
    expect(JSON.stringify(last.outboundBody)).toContain("again");
  } finally {
    proxy?.stop();
    stub.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
