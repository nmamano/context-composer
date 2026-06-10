// §11 Phase 2.6 acceptance — wire-integrity DETECTION. Compose is FAITHFUL: suspect
// blocks are detected and surfaced, never altered or dropped. (The earlier drop-the-
// husk sweep was deleted after live evidence showed agent-signed empty husks pass
// through our full rewrite — see src/engine/wire-integrity.ts for the history.)

import { expect, test } from "bun:test";
import { detectWireIssues } from "../src/engine/wire-integrity.ts";
import { FrameStore } from "../src/engine/state.ts";
import type { WireMessage } from "../src/engine/types.ts";

test("detects empty/missing/whitespace thinking, flags signed vs unsigned", () => {
  const msgs: WireMessage[] = [
    { role: "user", content: "q" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig1" }, // signed husk (agent-normal)
        { type: "thinking", signature: "sig2" }, // missing text
        { type: "thinking", thinking: "   \n\t " }, // whitespace-only, UNSIGNED (proxy-bug class)
        { type: "text", text: "hi" },
      ],
    },
  ];
  expect(detectWireIssues(msgs)).toEqual([
    { issue: "empty-thinking", messageIndex: 1, blockIndex: 0, signed: true },
    { issue: "empty-thinking", messageIndex: 1, blockIndex: 1, signed: true },
    { issue: "empty-thinking", messageIndex: 1, blockIndex: 2, signed: false },
  ]);
});

test("ignores non-empty thinking, redacted_thinking, string content, user messages", () => {
  const msgs: WireMessage[] = [
    { role: "user", content: [{ type: "text", text: "thinking: " }] },
    { role: "assistant", content: "plain string answer" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "real reasoning", signature: "s" },
        { type: "redacted_thinking", data: "EncRyptEd==" },
        { type: "tool_use", id: "tu1", name: "Read", input: {} },
      ],
    },
  ];
  expect(detectWireIssues(msgs)).toEqual([]);
});

test("compose is faithful: husk stays on the wire byte-for-byte, warning surfaced", () => {
  const store = new FrameStore(null);
  store.ingest({
    model: "m",
    max_tokens: 10,
    system: "SYS",
    messages: [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "", signature: "sig" }, // agent-sent husk
          { type: "tool_use", id: "tu1", name: "Read", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "line" }] },
    ],
  });

  const first = store.compose();
  const asst = (first.body.messages as any[]).find((m) => m.role === "assistant");
  // NOT dropped, NOT mutated — exactly what the agent sent (minus cache_control, which we own).
  expect(asst.content[0]).toEqual({ type: "thinking", thinking: "", signature: "sig" });
  expect(first.wireWarnings).toEqual([
    { issue: "empty-thinking", messageIndex: 1, blockIndex: 0, signed: true },
  ]);

  // Detection touches nothing — the head hash is deterministic and unaffected.
  const second = store.compose();
  expect(second.headHash).toBe(first.headHash);
  expect(first.hasCacheBreakpoint).toBe(true);

  // An UNSIGNED husk (capture-fabrication bug class) is flagged as such.
  const store2 = new FrameStore(null);
  store2.ingest({
    model: "m",
    max_tokens: 10,
    system: "SYS",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "a" }] },
      { role: "user", content: "next" },
    ],
  });
  expect(store2.compose().wireWarnings[0]).toMatchObject({ issue: "empty-thinking", signed: false });
});
