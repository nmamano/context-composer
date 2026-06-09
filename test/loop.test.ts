// Phase 1 acceptance — the engine loop end-to-end, driven through the REAL HTTP
// proxy + control API against a stub upstream (peer decision E: exercise the daemon
// loop and the CLI/proxy shared-state path, not pure functions).
//
// One scripted conversation hits every Phase 1 acceptance bullet (design.md §11):
//   • capture: a prompt yields a captured request; `list` shows preamble + turn frames
//   • delete:  the next forwarded request OMITS the deleted frame
//   • reconcile across a tool_use/tool_result round-trip: known frames matched, new
//     content appended, the deleted frame stays gone (the crux fixture — the unaware
//     agent resends the exact deleted content and it must not come back)
//   • inspectable compose: `compose --dump` prints the resolved payload (deletions omitted)
//   • determinism: `compose --hash-head` is byte-identical across no-op sends, with
//     a cache_control breakpoint on the stable head
//   • runtime knobs (model/max_tokens/temperature/stream) preserved verbatim

import { afterEach, beforeEach, expect, test } from "bun:test";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let proxy: ProxyHandle;
let stub: StubUpstream;

beforeEach(() => {
  stub = startStubUpstream();
  proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
});
afterEach(() => {
  proxy.stop();
  stub.stop();
});

const HEAD = {
  system: "SYS",
  tools: [
    {
      name: "get_weather",
      description: "Get weather",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
};
const KNOBS = { model: "claude-test", max_tokens: 1024, temperature: 0.7, stream: true };

const userA = { role: "user", content: "What is 2+2?" };
const asst4 = { role: "assistant", content: [{ type: "text", text: "4" }] };
const userB = { role: "user", content: "Weather in Paris?" };
const asstTU = {
  role: "assistant",
  content: [{ type: "tool_use", id: "tu1", name: "get_weather", input: { city: "Paris" } }],
};
const toolRes = { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "sunny" }] };

async function send(body: unknown): Promise<void> {
  const res = await fetch(`http://localhost:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test-key", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  await res.text(); // drain the passthrough stream so the capture branch completes
}
async function control(path: string): Promise<any> {
  return (await fetch(`http://localhost:${proxy.port}/control/${path}`)).json();
}
async function del(ids: string[]): Promise<any> {
  return (
    await fetch(`http://localhost:${proxy.port}/control/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  ).json();
}

test("tracer-bullet loop: capture, delete, reconcile across tool-loop, determinism", async () => {
  // ---- turn 1: a single prompt round-trips and is captured ----
  stub.enqueue({ text: "4", stopReason: "end_turn" });
  await send({ ...KNOBS, ...HEAD, messages: [userA] });

  let list = await control("list");
  const ids = list.frames.map((f: any) => f.id);
  expect(ids).toContain("p0"); // preamble frame (§2.7)
  expect(ids).toContain("t1"); // the user turn, with the captured assistant
  const t1 = list.frames.find((f: any) => f.id === "t1");
  expect(t1.messageCount).toBe(2); // user + captured assistant
  expect(t1.deleted).toBe(false);

  // forwarded turn-1 body = just the user turn; runtime knobs preserved verbatim
  expect((stub.received[0] as any).messages).toHaveLength(1);
  expect((stub.received[0] as any).model).toBe("claude-test");
  expect((stub.received[0] as any).max_tokens).toBe(1024);
  expect((stub.received[0] as any).temperature).toBe(0.7);
  expect((stub.received[0] as any).stream).toBe(true);

  const hashAfterT1 = (await control("compose?hashHead")).headHash;

  // ---- delete the frame, then inspect compose (deletions omitted) ----
  expect((await del(["t1"])).deleted).toEqual(["t1"]);
  const dumpAfterDelete = await control("compose?dump");
  expect(dumpAfterDelete.body.messages).toHaveLength(0); // t1 omitted, nothing else yet

  // cache_control breakpoint sits on the last block of the stable head
  const sys = dumpAfterDelete.body.system;
  expect(Array.isArray(sys)).toBe(true);
  expect(sys[sys.length - 1].cache_control).toEqual({ type: "ephemeral" });

  // ---- turn 2: unaware agent RESENDS the deleted content + a new user turn ----
  // (the reconciliation crux fixture: deleted frame must stay gone)
  stub.enqueue({ toolUse: { id: "tu1", name: "get_weather", input: { city: "Paris" } }, stopReason: "tool_use" });
  await send({ ...KNOBS, ...HEAD, messages: [userA, asst4, userB] });

  // forwarded turn-2 body omits the deleted frame entirely
  const fwd2 = (stub.received[1] as any).messages;
  expect(fwd2).toHaveLength(1);
  expect(fwd2[0].content).toBe("Weather in Paris?");

  // ---- turn 3: tool result comes back (multi-turn tool loop) ----
  stub.enqueue({ text: "It's sunny in Paris", stopReason: "end_turn" });
  await send({ ...KNOBS, ...HEAD, messages: [userA, asst4, userB, asstTU, toolRes] });

  // reconciliation proof: known frame (userB) matched & grown with the tool loop;
  // deleted frame (userA/asst4) still omitted; new content appended.
  const fwd3 = (stub.received[2] as any).messages;
  expect(fwd3).toHaveLength(3);
  expect(fwd3[0].content).toBe("Weather in Paris?");
  expect(fwd3[1].content[0].type).toBe("tool_use");
  expect(fwd3[2].content[0].type).toBe("tool_result");

  // active frame list: preamble + the surviving turn frame; deleted one hidden
  list = await control("list");
  const active = list.frames.filter((f: any) => !f.deleted).map((f: any) => f.id);
  expect(active).toEqual(["p0", "t2"]);
  expect(list.frames.find((f: any) => f.id === "t1").deleted).toBe(true);

  // ---- determinism: head byte-stable across no-op compose calls ----
  const h1 = await control("compose?hashHead");
  const h2 = await control("compose?hashHead");
  expect(h1.headHash).toBe(h2.headHash);
  expect(h1.hasCacheBreakpoint).toBe(true);
  // head never changed across the whole run
  expect(h1.headHash).toBe(hashAfterT1);
});
