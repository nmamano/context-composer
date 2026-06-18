// §11 Phase 3d acceptance — SUB-FRAME CONTENT OPS (drop-results/summarize-results/retitle) +
// the LLM port. drop-results/summarize-results transform the frame's CURRENT emission: only
// the targeted tool_result blocks' CONTENT changes (type/tool_use_id/is_error
// preserved — the tool pair stays intact; the §5.F sweep is a safety net, not
// the mechanism). retitle is pure display metadata. The LLM lives at the proxy
// layer behind an injected port: FrameStore stays deterministic, gates never
// need an API key, and a failed/unconfigured regen mutates NOTHING.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameStore } from "../src/engine/state.ts";
import { JsonFileStore } from "../src/engine/store.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-sub-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = { model: "m", max_tokens: 64, system: "SYS" };
const TOOL_TURN = [
  { role: "user", content: "read both files" },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I will read both files now" },
      { type: "tool_use", id: "tuA", name: "Read", input: { path: "a" } },
      { type: "tool_use", id: "tuB", name: "Read", input: { path: "b" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tuA", content: "HUGE CONTENT A ".repeat(40), is_error: false },
      { type: "tool_result", tool_use_id: "tuB", content: "HUGE CONTENT B ".repeat(40) },
    ],
  },
  { role: "assistant", content: "both files read; key fact: the port is 9442" },
];

function mk(): FrameStore {
  return new FrameStore(null, "test", join(dir, "frames"));
}

// ── drop-results: content stubbed, structure + reasoning intact ──────────────
test("drop-results --result: stubs only that result's content; pair, reasoning, source intact; tokens drop", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: TOOL_TURN });
  const before = s.show("t1")!.tokenEstimate;

  const r = s.dropResults("t1", { resultIds: ["tuA"] });
  expect(r.ok).toBe(true);
  const c = s.compose();
  const w = JSON.stringify(c.body);
  expect(w).not.toContain("HUGE CONTENT A");
  expect(w).toContain("[stripped by user]");
  expect(w).toContain("HUGE CONTENT B"); // untargeted result untouched
  expect(w).toContain("I will read both files now"); // reasoning untouched
  expect(w).toContain("key fact: the port is 9442");
  // Structure preserved: both tool_use blocks AND both tool_result blocks remain.
  expect(w.split('"tool_use"').length - 1).toBe(2);
  expect(w.split('"tool_result"').length - 1).toBe(2);
  expect(w).toContain('"is_error":false'); // structural fields preserved
  expect(c.wireRepairs).toEqual([]); // sweep had nothing to do — not the mechanism

  // Source untouched (zero loss); tokens track the post-op emission.
  expect(JSON.stringify(s.show("t1")!.messages)).toContain("HUGE CONTENT A");
  expect(s.show("t1")!.tokenEstimate).toBeLessThan(before);
});

test("drop-results --all-results + refusals: unknown id and no-results refuse with NO mutation", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: TOOL_TURN });

  // Unknown id refuses, nothing changes (no commit, no representation).
  const bad = s.dropResults("t1", { resultIds: ["tuA", "ghost"] });
  expect(bad.ok).toBe(false);
  expect((bad as { ok: false; error: string }).error).toContain("ghost");
  expect(s.history()).toHaveLength(0);
  expect(s.show("t1")!.representation ?? null).toBeNull();

  // --all-results works on both.
  expect(s.dropResults("t1", { all: true }).ok).toBe(true);
  const w = JSON.stringify(s.compose().body);
  expect(w).not.toContain("HUGE CONTENT");
  expect(w.split("[stripped by user]").length - 1).toBe(2);

  // A frame with no tool_result refuses --all-results with no mutation.
  s.ingest({ ...HEAD, messages: [...TOOL_TURN, { role: "user", content: "plain turn" }] });
  const none = s.dropResults("t2", { all: true });
  expect(none.ok).toBe(false);
  expect(s.history()).toHaveLength(1); // only the earlier drop-results
});

test("duplicate tool_use_ids in a raw-authored representation: ALL matching blocks transform; params record", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [{ role: "user", content: "go" }] });
  s.edit("t1", {
    raw: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "dup", name: "X", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "dup", content: "copy one" },
          { type: "tool_result", tool_use_id: "dup", content: "copy two" },
        ],
      },
    ],
  });
  const r = s.dropResults("t1", { resultIds: ["dup"] });
  expect(r.ok).toBe(true);
  const params = (r as unknown as { commit: { params: { resultIds: string[]; blocks: number } } }).commit.params;
  expect(params.blocks).toBe(2);
  expect(params.resultIds).toEqual(["dup", "dup"]);
  const w = JSON.stringify(s.compose().body);
  expect(w).not.toContain("copy one");
  expect(w).not.toContain("copy two");
});

// ── summarize-results: one summary repeated across selected results ──────────
test("summarize-results manual: one supplied summary written into each selected result; revert restores", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: TOOL_TURN });
  const r = s.summarizeResults("t1", { all: true }, "both reads succeeded; port 9442");
  expect(r.ok).toBe(true);
  const w = JSON.stringify(s.compose().body);
  expect(w).not.toContain("HUGE CONTENT");
  expect(w.split("both reads succeeded; port 9442").length - 1).toBe(2); // repeated per result
  expect(s.history().map((c) => c.type)).toEqual(["summarize-results"]);

  // Revert: full results back on the wire.
  expect(s.revert().ok).toBe(true);
  expect(JSON.stringify(s.compose().body)).toContain("HUGE CONTENT A");
});

// ── retitle: pure metadata ────────────────────────────────────────────────────
test("retitle: title+summary set and reverted; body and head hash byte-identical; allowed on offloaded/preamble", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: TOOL_TURN });
  const beforeCompose = s.compose();
  const beforeBody = JSON.stringify(beforeCompose.body);

  const r = s.retitle("t1", { title: "the two-file read", summary: "read a+b, port 9442" });
  expect(r.ok).toBe(true);
  const f = s.list().find((x) => x.id === "t1")!;
  expect(f.title).toBe("the two-file read");
  expect(f.summary).toBe("read a+b, port 9442");
  // Emission byte-identical: retitle is display metadata only.
  const afterCompose = s.compose();
  expect(JSON.stringify(afterCompose.body)).toBe(beforeBody);
  expect(afterCompose.headHash).toBe(beforeCompose.headHash);

  // Revert restores BOTH fields.
  expect(s.revert().ok).toBe(true);
  const back = s.list().find((x) => x.id === "t1")!;
  expect(back.title).toBe("frame t1");
  expect(back.summary).toBeNull();

  // Allowed on the preamble and on offloaded frames (metadata only); deleted refuses.
  expect(s.retitle("p0", { title: "the big head" }).ok).toBe(true);
  s.offload("t1");
  expect(s.retitle("t1", { title: "offloaded but labeled" }).ok).toBe(true);
  s.restore("t1");
  s.delete(["t1"]);
  expect(s.retitle("t1", { title: "nope" }).ok).toBe(false);
});

// ── guards matrix ─────────────────────────────────────────────────────────────
test("drop-results/summarize-results guards: offloaded/absorbed/preamble refuse; combined frames are ordinary targets", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [...TOOL_TURN, { role: "user", content: "turn two" }] });

  expect(s.dropResults("p0", { all: true }).ok).toBe(false);
  s.offload("t1");
  expect(s.dropResults("t1", { all: true }).ok).toBe(false);
  s.restore("t1");

  // Combine t1+t2 → the combined frame is an ordinary content target.
  const cb = s.combine(["t1", "t2"]);
  const combinedId = (cb as unknown as { commit: { params: { combinedId: string } } }).commit.params.combinedId;
  expect(s.dropResults("t1", { all: true }).ok).toBe(false); // absorbed part refuses
  const r = s.dropResults(combinedId, { all: true });
  expect(r.ok).toBe(true);
  expect(JSON.stringify(s.compose().body)).not.toContain("HUGE CONTENT");
});

// ── LLM port: regen through the proxy; failure mutates nothing ────────────────
test("regen via injected stub: summarize/compact/retitle; missing-llm and thrown-client mutate NOTHING", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  const calls: string[] = [];
  try {
    proxy = startProxy({
      port: 0,
      upstreamBaseUrl: stub.baseUrl,
      framesDir: join(dir, "frames"),
      llm: {
        complete: async (prompt: string) => {
          calls.push(prompt);
          if (prompt.includes("FAIL-MARKER")) throw new Error("boom");
          // Two-line retitle contract; single line everywhere else.
          if (prompt.includes("EXACTLY two lines")) return "Generated Title\nGenerated one-line summary.";
          return "LLM OUTPUT";
        },
      },
    });
    const base = `http://localhost:${proxy.port}`;
    const ctl = (path: string, body: unknown) =>
      fetch(`${base}/control/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    stub.enqueue({ text: "r1", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...HEAD, messages: TOOL_TURN }),
    })).text();
    await fetch(`${base}/control/list`);

    // summarize --regen: stub output lands in every selected result.
    const sum = (await (await ctl("summarize-results", { id: "t1", all: true, regen: true })).json()) as any;
    expect(sum.commit.type).toBe("summarize-results");
    const c = (await (await fetch(`${base}/control/compose?dump`)).json()) as any;
    expect(JSON.stringify(c.body)).toContain("LLM OUTPUT");
    expect(calls[0]).toContain("read both files"); // prompt carried the emission

    // retitle --regen: the two-line contract sets BOTH title and summary
    // (reviewer-caught: the §11 3d acceptance is title/summary, not title-only),
    // and both are visible on the list-facing summary surface.
    const ret = (await (await ctl("retitle", { id: "t1", regen: true })).json()) as any;
    expect(ret.commit.type).toBe("retitle");
    expect(ret.commit.params.after).toEqual({
      title: "Generated Title",
      summary: "Generated one-line summary.",
    });
    const listed = ((await (await fetch(`${base}/control/list`)).json()) as any).frames
      .find((x: any) => x.id === "t1");
    expect(listed.title).toBe("Generated Title");
    expect(listed.summary).toBe("Generated one-line summary."); // list-facing surface
    const cp = (await (await ctl("compact", { id: "t1", regen: true })).json()) as any;
    expect(cp.commit.type).toBe("compact");

    // Thrown client: 502, NO commit recorded (FAIL-MARKER reaches the prompt
    // via the retitled frame title rendered into the regen input).
    await ctl("retitle", { id: "t1", title: "FAIL-MARKER" });
    const histBefore = ((await (await fetch(`${base}/control/history`)).json()) as any).commits.length;
    const fail = await ctl("summarize-results", { id: "t1", all: true, regen: true });
    expect(fail.status).toBe(502);
    const histAfter = ((await (await fetch(`${base}/control/history`)).json()) as any).commits.length;
    expect(histAfter).toBe(histBefore);
  } finally {
    proxy?.stop();
    stub.stop();
  }

  // Missing LLM entirely (explicit null — no env fallback): clear 400, no commit.
  const stub2: StubUpstream = startStubUpstream();
  let proxy2: ProxyHandle | undefined;
  try {
    proxy2 = startProxy({ port: 0, upstreamBaseUrl: stub2.baseUrl, framesDir: join(dir, "frames2"), llm: null });
    const base = `http://localhost:${proxy2.port}`;
    stub2.enqueue({ text: "r1", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...HEAD, messages: TOOL_TURN }),
    })).text();
    await fetch(`${base}/control/list`);
    const res = await fetch(`${base}/control/summarize-results`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t1", all: true, regen: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain("CC_LLM_API_KEY");
    const hist = (await (await fetch(`${base}/control/history`)).json()) as any;
    expect(hist.commits).toHaveLength(0);
  } finally {
    proxy2?.stop();
    stub2.stop();
  }
});

// ── durability: snapshot v7 ───────────────────────────────────────────────────
test("summary metadata and drop-results representation survive a restart (snapshot v7)", () => {
  const storePath = join(dir, "store.json");
  const reopen = () => new FrameStore(new JsonFileStore(storePath), "test", join(dir, "frames"));
  const s1 = reopen();
  s1.ingest({ ...HEAD, messages: TOOL_TURN });
  s1.dropResults("t1", { resultIds: ["tuA"] });
  s1.retitle("t1", { title: "the read", summary: "two files" });

  const s2 = reopen();
  const f = s2.list().find((x) => x.id === "t1")!;
  expect(f.title).toBe("the read");
  expect(f.summary).toBe("two files");
  const w = JSON.stringify(s2.compose().body);
  expect(w).toContain("[stripped by user]");
  expect(w).not.toContain("HUGE CONTENT A");
  expect(w).toContain("HUGE CONTENT B");
});
