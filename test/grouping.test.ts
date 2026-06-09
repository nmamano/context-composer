// Frame-grouping (decision B) and the documented duplicate-fingerprint limitation
// (decision A). Driven at the engine level via FrameStore — focused and fast; the
// HTTP daemon loop is covered in loop.test.ts.

import { expect, test } from "bun:test";
import { FrameStore } from "../src/engine/state.ts";
import { fingerprintMessage } from "../src/engine/fingerprint.ts";

const HEAD = { system: "SYS", tools: [{ name: "t", description: "d", input_schema: { type: "object" } }] };

function turnFrames(store: FrameStore) {
  return store.list().filter((f) => f.kind === "turn");
}

test("a user message of only tool_result blocks continues the open frame", () => {
  const store = new FrameStore();
  store.ingest({
    ...HEAD,
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "t", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "sunny" }] },
    ],
  });
  const frames = turnFrames(store);
  expect(frames).toHaveLength(1); // the tool loop bundles into ONE frame (§2.1)
  expect(frames[0]!.messageCount).toBe(3);
});

test("multiple tool_result blocks in one user message still continue (not a new frame)", () => {
  const store = new FrameStore();
  store.ingest({
    ...HEAD,
    messages: [
      { role: "user", content: "two tools" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "a", name: "t", input: {} },
          { type: "tool_use", id: "b", name: "t", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "ra" },
          { type: "tool_result", tool_use_id: "b", content: "rb" },
        ],
      },
    ],
  });
  expect(turnFrames(store)).toHaveLength(1);
});

test("a mixed-content user message opens a new human frame (real text not swallowed)", () => {
  const store = new FrameStore();
  store.ingest({
    ...HEAD,
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "t", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "sunny" },
          { type: "text", text: "thanks — and what about tomorrow?" },
        ],
      },
    ],
  });
  // The mixed message is genuine user text alongside a result -> it opens its own frame.
  expect(turnFrames(store)).toHaveLength(2);
});

test("agent-injected system-role message is lifted to the head, not a turn (decision F)", () => {
  const store = new FrameStore();
  store.ingest({
    ...HEAD,
    messages: [
      { role: "system", content: "INJECTED MEMORY" },
      { role: "user", content: "hi" },
    ],
  });

  expect(turnFrames(store)).toHaveLength(1); // only the user turn is a frame
  const body = store.compose().body as any;

  // No system-role entry leaks into `messages` (would be invalid for Anthropic).
  for (const m of body.messages) expect(["user", "assistant"]).toContain(m.role);

  // Injected content folded into the head system, after the base system block.
  const texts = (body.system as any[]).map((b) => b.text);
  expect(texts).toEqual(["SYS", "INJECTED MEMORY"]); // deterministic order

  // Exactly one owned breakpoint, on the STABLE head (base system), not on injected.
  const withBp = (body.system as any[]).filter((b) => b.cache_control);
  expect(withBp).toHaveLength(1);
  expect(withBp[0].text).toBe("SYS");
});

test("deleting the preamble strips system/tools and stays stripped on unaware resend", () => {
  const store = new FrameStore();
  const req = { ...HEAD, messages: [{ role: "user", content: "hi" }] };
  store.ingest(req);

  expect(store.delete(["p0"])).toEqual(["p0"]);
  store.ingest(req); // unaware agent resends the full head

  const composed = store.compose();
  expect((composed.body as any).system).toBeUndefined();
  expect((composed.body as any).tools).toBeUndefined();
  expect(composed.hasCacheBreakpoint).toBe(false);
});

test("fingerprint ignores cache_control (the live reconciliation finding)", () => {
  // Real Claude Code attaches cache_control to a message block on one turn and moves it
  // the next; the same message must hash identically with or without the marker.
  const withCC = {
    role: "user" as const,
    content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral", ttl: "1h" } }],
  };
  const without = { role: "user" as const, content: [{ type: "text", text: "hi" }] };
  expect(fingerprintMessage(withCC)).toBe(fingerprintMessage(without));
});

test("deleted frame stays deleted when the agent resends it with cache_control moved", () => {
  // Mirrors the live A/B failure: delete a turn, then the unaware agent resends the
  // identical content but with its cache_control marker relocated. The frame must remain
  // omitted — not reappear as a new frame leaking the secret.
  const store = new FrameStore();
  const secretWithCC = {
    role: "user",
    content: [{ type: "text", text: "My secret is ZEPHYR", cache_control: { type: "ephemeral", ttl: "1h" } }],
  };
  const secretNoCC = { role: "user", content: [{ type: "text", text: "My secret is ZEPHYR" }] };

  store.ingest({ ...HEAD, messages: [secretWithCC] });
  store.delete(["t1"]);
  store.ingest({
    ...HEAD,
    messages: [
      secretNoCC, // resent, marker gone
      { role: "assistant", content: [{ type: "text", text: "OK" }] },
      { role: "user", content: "next question?" },
    ],
  });

  const body = store.compose().body;
  expect(JSON.stringify(body.messages)).not.toContain("ZEPHYR");
});

test("duplicate identical frames: documented tombstone limitation", () => {
  // Two byte-identical user messages collide on fingerprint and are disambiguated
  // only by occurrence order. If you delete the FIRST and the unaware agent resends
  // both, the greedy ordered match binds the first resend to the tombstone — so one
  // copy stays omitted even though, from the agent's view, both are present. This is
  // the accepted Phase 1 limitation; this test pins the behavior so it's a known
  // quantity, not a surprise.
  const dup = { role: "user", content: "ping" };
  const store = new FrameStore();
  store.ingest({ ...HEAD, messages: [dup, dup] });
  expect(turnFrames(store)).toHaveLength(2); // t1, t2 (occurrence 0 and 1)

  store.delete(["t1"]);
  store.ingest({ ...HEAD, messages: [dup, dup] }); // unaware resend of both

  const composed = store.compose();
  // Only ONE copy survives (t2); the first resend matched the t1 tombstone.
  expect((composed.body.messages as unknown[])).toHaveLength(1);
});
