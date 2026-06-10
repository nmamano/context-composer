// §11 Phase 2.6 acceptance — CAPTURE FIDELITY: the captured assistant must equal what the
// wrapped agent will resend next turn, or reconcile sees two different turns and
// duplicates state. The live finding this guards against: capture used to ignore
// thinking/signature deltas, fabricating UNSIGNED empty husks the agent never sent,
// while the agent resent the real (signed) blocks — capture ≠ resend.

import { expect, test } from "bun:test";
import { reconstructFromSSE } from "../src/engine/sse.ts";
import { FrameStore } from "../src/engine/state.ts";
import { makeSSE } from "./stub-upstream.ts";

test("captures full thinking text + signature from the SSE stream", () => {
  const raw = makeSSE({
    thinking: { text: "let me reason", signature: "sigA" },
    text: "the answer",
    stopReason: "end_turn",
  });
  const cap = reconstructFromSSE(raw);
  expect(cap.message.content).toEqual([
    { type: "thinking", thinking: "let me reason", signature: "sigA" },
    { type: "text", text: "the answer" },
  ]);
  expect(cap.stopReason).toBe("end_turn");
});

test("captures the real husk shape faithfully (signed, empty text — preserved as sent)", () => {
  // The husk-producing stream: a thinking block START with no thinking_delta, but a
  // signature_delta (this is how the agent's own assembler ends up replaying
  // {thinking:"", signature} husks). We must capture EXACTLY that — not invent text,
  // not lose the signature.
  const raw = makeSSE({
    thinking: { text: "", signature: "sigHusk" },
    toolUse: { id: "tu1", name: "Read", input: { path: "README.md" } },
    stopReason: "tool_use",
  });
  const cap = reconstructFromSSE(raw);
  expect(cap.message.content).toEqual([
    { type: "thinking", thinking: "", signature: "sigHusk" },
    { type: "tool_use", id: "tu1", name: "Read", input: { path: "README.md" } },
  ]);
});

test("keeps redacted_thinking blocks (arrive complete in their start event)", () => {
  const raw =
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "redacted_thinking", data: "EncRyptEd==" },
    })}\n\n` +
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}\n\n`;
  const cap = reconstructFromSSE(raw);
  expect(cap.message.content).toEqual([{ type: "redacted_thinking", data: "EncRyptEd==" }]);
});

// The end-to-end regression: capture == resend → reconcile matches → NO duplicate
// tool_use on the wire (the wedged-store failure chain, link by link).
test("capture == resend: a thinking+tool_use turn does not duplicate across the resend", () => {
  const store = new FrameStore(null);
  const HEAD = { model: "m", max_tokens: 10, system: "SYS" };

  // Turn N request arrives; we capture the streamed assistant (thinking + tool_use).
  store.ingest({ ...HEAD, messages: [{ role: "user", content: "read the file" }] });
  const cap = reconstructFromSSE(
    makeSSE({
      thinking: { text: "I should call Read", signature: "sigT" },
      toolUse: { id: "tuX", name: "Read", input: { path: "README.md" } },
      stopReason: "tool_use",
    }),
  );
  store.captureAssistant(cap, store.openFrameId());

  // Turn N+1: the unaware agent resends its own assembled history — the SAME assistant
  // blocks — plus the tool_result. Reconcile must match the existing frame, not append.
  store.ingest({
    ...HEAD,
    messages: [
      { role: "user", content: "read the file" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should call Read", signature: "sigT" },
          { type: "tool_use", id: "tuX", name: "Read", input: { path: "README.md" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tuX", content: "# line" }] },
    ],
  });

  const turnFrames = store.list().filter((f) => f.kind === "turn");
  expect(turnFrames).toHaveLength(1); // matched, not duplicated

  const wire = JSON.stringify(store.compose().body);
  expect(wire.split('"tuX"').length - 1).toBe(2); // exactly one tool_use + its one tool_result
  expect(wire).toContain("I should call Read"); // thinking preserved verbatim, signature intact
  expect(wire).toContain("sigT");
});
