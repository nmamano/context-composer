// Human-readable Phase 1 validation. No API key needed: it spins up the real proxy
// against an in-process stub upstream and narrates what the MODEL actually receives at
// each step, so you can SEE that a deleted frame is omitted from the rewritten request
// even though the unaware agent keeps resending it.
//
//   bun run scripts/phase1-walkthrough.ts
//
// Exit code is non-zero if any invariant fails, so it doubles as a smoke test.

import { startProxy } from "../src/proxy/server.ts";
import { startStubUpstream } from "../test/stub-upstream.ts";

const stub = startStubUpstream();
const proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
const P = proxy.port;

const HEAD = {
  system: "You are a helpful assistant.",
  tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
};
const KNOBS = { model: "claude-test", max_tokens: 256, temperature: 0.7, stream: true };

const userA = { role: "user", content: "What is 2+2?" };
const asst4 = { role: "assistant", content: [{ type: "text", text: "4" }] };
const userB = { role: "user", content: "What's the weather in Paris?" };

async function send(messages: unknown[]) {
  const res = await fetch(`http://localhost:${P}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ ...KNOBS, ...HEAD, messages }),
  });
  await res.text(); // drain stream so capture completes
}
async function ctl(path: string) {
  return (await fetch(`http://localhost:${P}/control/${path}`)).json();
}
function received(i: number) {
  return ((stub.received[i] as any)?.messages ?? []).map((m: any) =>
    typeof m.content === "string" ? `${m.role}:"${m.content}"` : `${m.role}:[${m.content.map((b: any) => b.type).join(",")}]`,
  );
}
function line(s = "") {
  console.log(s);
}

const checks: Array<[string, boolean]> = [];
function check(label: string, ok: boolean) {
  checks.push([label, ok]);
}

line("\n══════════ Phase 1 walkthrough — model-unaware delete at the boundary ══════════\n");

// ── Turn 1 ──────────────────────────────────────────────────────────────────
stub.enqueue({ text: "2 + 2 = 4", stopReason: "end_turn" });
await send([userA]);
line('TURN 1 — you ask "What is 2+2?"');
line(`   model received:  [ ${received(0).join(" | ")} ]`);
let list = (await ctl("list")).frames.filter((f: any) => !f.deleted).map((f: any) => f.id);
line(`   ctx list:        ${list.join(", ")}   (p0 = system+tools, t1 = the Q&A)\n`);

// ── Delete ──────────────────────────────────────────────────────────────────
await fetch(`http://localhost:${P}/control/delete`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ids: ["t1"] }),
});
line("DELETE — you run:  ctx delete t1");
list = (await ctl("list")).frames.filter((f: any) => !f.deleted).map((f: any) => f.id);
line(`   ctx list:        ${list.join(", ")}   (t1 is gone from the active context)\n`);

// ── Turn 2 (the crux: agent resends the deleted content, unaware) ────────────
stub.enqueue({ text: "I can't see that earlier exchange.", stopReason: "end_turn" });
await send([userA, asst4, userB]); // the agent STILL carries the deleted Q&A
line('TURN 2 — the unaware agent resends the FULL history + your new question:');
line(`   agent sent us:   [ user:"What is 2+2?" | assistant:[text] | user:"...weather in Paris?" ]`);
line(`   model received:  [ ${received(1).join(" | ")} ]   ← deleted Q&A omitted!`);
const dump = await ctl("compose?dump");
const sys = dump.body.system;
line(`   compose --dump:  ${(dump.body.messages as any[]).length} message(s), deleted frame absent`);
line(`   cache marker:    system[last].cache_control = ${JSON.stringify(sys[sys.length - 1].cache_control)}\n`);

// ── Invariants ───────────────────────────────────────────────────────────────
check("turn 1 forwarded exactly the question", received(0).length === 1);
check("delete removed t1 from active list", !list.includes("t1"));
check("turn 2 OMITS the deleted Q&A (model-unaware)", received(1).length === 1 && received(1)[0] === 'user:"What\'s the weather in Paris?"');
check("runtime knobs preserved (model/max_tokens/stream)", (stub.received[1] as any).model === "claude-test" && (stub.received[1] as any).max_tokens === 256 && (stub.received[1] as any).stream === true);
check("cache_control on the stable head", !!sys[sys.length - 1].cache_control);

line("──────────────────────────────── invariants ────────────────────────────────");
for (const [label, ok] of checks) line(`   ${ok ? "✅" : "❌"}  ${label}`);
const allOk = checks.every(([, ok]) => ok);
line(`\n${allOk ? "ALL PASS ✅" : "SOME FAILED ❌"}\n`);

proxy.stop();
stub.stop();
process.exit(allOk ? 0 : 1);
