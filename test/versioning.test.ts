// Phase 2 acceptance — the versioning spine across the persistence boundary
// (design.md §11 "Phase 2"). Two layers, mirroring Phase 1's split:
//   • engine-level (FrameStore + JsonFileStore on a temp file) — fast, exercises the
//     durable round-trip, commit graph, provenance, revert error cases, loud-fail;
//   • HTTP-level (startProxy + stub upstream) — the LITERAL restart acceptance: a real
//     proxy is stopped and a fresh one is started on the same store between each step.
//
// The crux the peer called out: the inversion must cross PROCESS boundaries — delete
// after one restart, revert after a second — and Phase-1 invariants (tombstone wins,
// deterministic head) must survive persistence.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameStore } from "../src/engine/state.ts";
import { JsonFileStore } from "../src/engine/store.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-ver-"));
  storePath = join(dir, "store.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = {
  system: "SYS",
  tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
};
const KNOBS = { model: "claude-test", max_tokens: 256, temperature: 0.7, stream: true };
const userA = { role: "user", content: "What is 2+2?" };
const userB = { role: "user", content: "Weather in Paris?" };

/** A fresh FrameStore over the SAME on-disk store — i.e. a process restart. */
function reopen(): FrameStore {
  return new FrameStore(new JsonFileStore(storePath));
}
function turnIds(store: FrameStore): string[] {
  return store
    .list()
    .filter((f) => f.kind === "turn")
    .map((f) => f.id);
}

// ── durable round-trip ───────────────────────────────────────────────────────
test("frames persist across a restart (durable store)", () => {
  const s1 = reopen();
  s1.ingest({ ...KNOBS, ...HEAD, messages: [userA] });
  expect(turnIds(s1)).toEqual(["t1"]);

  const s2 = reopen(); // restart
  expect(s2.list().map((f) => f.id)).toEqual(["p0", "t1"]);
  expect(s2.show("t1")!.messages[0]!.content).toBe("What is 2+2?");
});

// ── delete is a commit; history shows it; provenance records lineage ──────────
test("delete records an implicit commit with provenance; history shows only user ops", () => {
  const s = reopen();
  s.ingest({ ...KNOBS, ...HEAD, messages: [userA] }); // session-ingest, NOT a commit
  expect(s.history()).toHaveLength(0); // ingest didn't create a commit

  expect(s.delete(["t1"])).toEqual(["t1"]);
  const hist = s.history();
  expect(hist).toHaveLength(1);
  expect(hist[0]!.type).toBe("delete");
  expect(hist[0]!.affectedFrameIds).toEqual(["t1"]);
  expect(hist[0]!.branchId).toBe("main");
  expect(hist[0]!.parentCommitId).toBeNull();
  expect(s.show("t1")!.provenance).toEqual([hist[0]!.id]); // op lineage on the frame

  // a second ingest (resend) is still not a commit — history stays length 1
  s.ingest({ ...KNOBS, ...HEAD, messages: [userA, userB] });
  expect(s.history()).toHaveLength(1);
});

// ── history excludes capture even after a tool-loop ───────────────────────────
test("captureAssistant persists but does not appear in history", () => {
  const s = reopen();
  s.ingest({ ...KNOBS, ...HEAD, messages: [userA] });
  s.captureAssistant(
    { message: { role: "assistant", content: [{ type: "text", text: "4" }] }, stopReason: "end_turn" },
    s.openFrameId(),
  );
  expect(s.show("t1")!.messages).toHaveLength(2); // user + captured assistant
  expect(s.history()).toHaveLength(0); // capture is a session-ingest event, not a commit

  const s2 = reopen(); // the captured assistant survived the restart
  expect(s2.show("t1")!.messages).toHaveLength(2);
});

// ── the event log / timeline (position C) ─────────────────────────────────────
test("ingest records a capture EVENT (timeline), not a commit (history)", () => {
  const s = reopen();
  s.ingest({ ...KNOBS, ...HEAD, messages: [userA] });

  const tl = s.timeline();
  expect(tl).toHaveLength(1);
  expect(tl[0]!.type).toBe("capture");
  expect(tl[0]!.commitId).toBeNull(); // capture is not a commit
  expect(tl[0]!.frameIds).toEqual(["p0", "t1"]); // preamble + the new turn frame
  expect(s.history()).toHaveLength(0); // ...and it does NOT pollute the commit log

  // each created frame is stamped with its origin event (Appendix C: chronological
  // origin without being a representation override → provenance stays empty)
  expect(s.show("t1")!.createdEventId).toBe(tl[0]!.id);
  expect(s.show("t1")!.provenance).toEqual([]);
});

test("delete/revert appear in BOTH timeline (with commitId) and history", () => {
  const s = reopen();
  s.ingest({ ...KNOBS, ...HEAD, messages: [userA] });
  s.delete(["t1"]);
  const deleteCommit = s.history()[0]!.id;
  s.revert(deleteCommit);

  const tl = s.timeline();
  // capture, delete, revert — the complete chronology
  expect(tl.map((e) => e.type)).toEqual(["capture", "delete", "revert"]);
  const del = tl.find((e) => e.type === "delete")!;
  const rev = tl.find((e) => e.type === "revert")!;
  expect(del.commitId).toBe(deleteCommit); // event mirrors the commit
  expect(rev.commitId).toBe(s.history()[1]!.id);
  // history is the revertible subset
  expect(s.history().map((c) => c.type)).toEqual(["delete", "revert"]);
});

test("frame GROWTH via the resend (tool-loop) records a capture event", () => {
  const s = reopen();
  // turn 1: user asks; assistant replies with a tool_use (captured out-of-band)
  s.ingest({ ...KNOBS, ...HEAD, messages: [userB] });
  s.captureAssistant(
    {
      message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "get_weather", input: {} }] },
      stopReason: "tool_use",
    },
    s.openFrameId(),
  );
  const n = s.timeline().length;

  // next request: the unaware agent resends the frame GROWN with the tool_result
  s.ingest({
    ...KNOBS,
    ...HEAD,
    messages: [
      userB,
      { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "get_weather", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "sunny" }] },
    ],
  });

  const tl = s.timeline();
  expect(tl).toHaveLength(n + 1); // the growth is visible on the timeline
  expect(tl[tl.length - 1]!.type).toBe("capture");
  expect(tl[tl.length - 1]!.frameIds).toContain("t1");
  expect(tl[tl.length - 1]!.commitId).toBeNull(); // still not a commit
});

test("an identical resend (cache_control relocated) records NO new event", () => {
  const s = reopen();
  // array content on both turns so the only difference is the cache_control marker
  s.ingest({ ...KNOBS, ...HEAD, messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }] });
  const n = s.timeline().length;
  s.ingest({
    ...KNOBS,
    ...HEAD,
    messages: [{ role: "user", content: [{ type: "text", text: "ping", cache_control: { type: "ephemeral" } }] }],
  });
  expect(turnIds(s)).toEqual(["t1"]); // matched, not duplicated
  expect(s.timeline()).toHaveLength(n); // and no spurious timeline event
});

test("the timeline survives a restart", () => {
  const s1 = reopen();
  s1.ingest({ ...KNOBS, ...HEAD, messages: [userA] });
  s1.delete(["t1"]);
  const before = s1.timeline().map((e) => `${e.id}:${e.type}`);

  const s2 = reopen();
  expect(s2.timeline().map((e) => `${e.id}:${e.type}`)).toEqual(before);
  // event ids keep counting up after restart (no collision)
  s2.ingest({ ...KNOBS, ...HEAD, messages: [userA, userB] });
  const ids = s2.timeline().map((e) => e.id);
  expect(new Set(ids).size).toBe(ids.length); // all unique
});

// ── the cross-process inversion: delete after restart, revert after another ───
test("delete after restart, then revert after a SECOND restart, restores the frame", () => {
  reopen().ingest({ ...KNOBS, ...HEAD, messages: [userA] }); // restart #0: ingest

  const s1 = reopen(); // restart #1: delete
  expect(s1.delete(["t1"])).toEqual(["t1"]);
  const deleteCommit = s1.history()[0]!.id;

  const s2 = reopen(); // restart #2: the delete + its commit survived
  expect(s2.show("t1")!.deleted).toBe(true);
  expect(s2.history()).toHaveLength(1);

  const res = s2.revert(deleteCommit);
  expect(res.ok).toBe(true);
  expect(s2.show("t1")!.deleted).toBe(false); // restored
  const hist = s2.history();
  expect(hist).toHaveLength(2);
  expect(hist[1]!.type).toBe("revert");
  expect(hist[1]!.params.revertedCommitId).toBe(deleteCommit);
  expect(hist[1]!.parentCommitId).toBe(deleteCommit);
  expect(s2.show("t1")!.provenance).toEqual([deleteCommit, hist[1]!.id]);

  const s3 = reopen(); // restart #3: the revert is durable
  expect(s3.show("t1")!.deleted).toBe(false);
});

// ── revert with no arg targets HEAD only if revertible ────────────────────────
test("no-arg revert reverts a revertible HEAD; a non-revertible HEAD errors", () => {
  const s = reopen();
  s.ingest({ ...KNOBS, ...HEAD, messages: [userA] });
  s.delete(["t1"]);

  const ok = s.revert(); // HEAD is the delete commit → revertible
  expect(ok.ok).toBe(true);
  expect(s.show("t1")!.deleted).toBe(false);

  const again = s.revert(); // HEAD is now a `revert` commit → not revertible
  expect(again).toEqual({ ok: false, error: expect.stringContaining("revert") });
});

// ── revert refuses ambiguous cases with a clear error (no silent toggle) ──────
test("revert rejects: already-reverted, unknown, and non-delete commits", () => {
  const s = reopen();
  s.ingest({ ...KNOBS, ...HEAD, messages: [userA] });
  s.delete(["t1"]);
  const c1 = s.history()[0]!.id;

  expect(s.revert("nope").ok).toBe(false); // unknown commit
  const r = s.revert(c1);
  expect(r.ok).toBe(true);
  const revertCommit = s.history()[1]!.id;

  // reverting the same delete again must NOT silently re-toggle
  const dbl = s.revert(c1);
  expect(dbl).toEqual({ ok: false, error: expect.stringContaining("already reverted") });
  // reverting a revert commit is a non-delete → refused
  expect(s.revert(revertCommit).ok).toBe(false);
});

// ── Phase-1 invariant across the persistence boundary: tombstone wins ─────────
test("a deleted frame stays gone after restart when the unaware agent resends it", () => {
  const s1 = reopen();
  const secret = { role: "user", content: "My secret is ZEPHYR" };
  s1.ingest({ ...KNOBS, ...HEAD, messages: [secret] });
  s1.delete(["t1"]);

  const s2 = reopen(); // restart
  // unaware agent resends the deleted content + an assistant reply + a new turn
  s2.ingest({
    ...KNOBS,
    ...HEAD,
    messages: [secret, { role: "assistant", content: [{ type: "text", text: "OK" }] }, userB],
  });
  const body = s2.compose().body;
  expect(JSON.stringify(body.messages)).not.toContain("ZEPHYR"); // tombstone held
  expect(turnIds(s2)).toContain("t2"); // the new turn was appended (t2)
});

// ── deterministic head hash survives a restart ────────────────────────────────
test("compose head hash is identical across a restart", () => {
  const s1 = reopen();
  s1.ingest({ ...KNOBS, ...HEAD, messages: [userA] });
  const h1 = s1.compose().headHash;
  const s2 = reopen();
  expect(s2.compose().headHash).toBe(h1);
  expect(s2.compose().hasCacheBreakpoint).toBe(true);
});

// ── stored wire content has cache_control normalized out ──────────────────────
test("the durable store strips cache_control from persisted content", () => {
  const s = reopen();
  s.ingest({
    ...KNOBS,
    ...HEAD,
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  });
  const raw = Bun.file(storePath).text(); // read the bytes on disk
  return raw.then((txt) => {
    expect(txt).not.toContain("cache_control");
    // identity is still stable: a reopened store matches the resend (no leak as "new")
    const s2 = reopen();
    s2.ingest({ ...KNOBS, ...HEAD, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(turnIds(s2)).toEqual(["t1"]); // matched, not duplicated
  });
});

// ── corrupt store fails LOUDLY (never silently empty) ─────────────────────────
test("a corrupt store throws on load rather than starting empty", () => {
  writeFileSync(storePath, "{ this is not json");
  expect(() => reopen()).toThrow(/corrupt/);
});

// ── a failed save surfaces a CLEAR error (in-memory state stays intact) ───────
test("a failed persist throws a clear error instead of a raw fs trace", () => {
  const badPath = join(dir, "missing-dir", "store.json"); // parent dir does not exist
  const s = new FrameStore(new JsonFileStore(badPath));
  expect(() => s.ingest({ ...KNOBS, ...HEAD, messages: [userA] })).toThrow(
    /failed to persist/,
  );
});

// ── HTTP-level literal restart acceptance (the §11 acceptance, end to end) ────
test("acceptance: restart → list → delete → history → restart → revert → next send reflects it", async () => {
  const stub: StubUpstream = startStubUpstream();
  const port = 8799;

  async function send(messages: unknown[]): Promise<void> {
    const res = await fetch(`http://localhost:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ ...KNOBS, ...HEAD, messages }),
    });
    await res.text();
  }
  async function ctlGet(p: string): Promise<any> {
    return (await fetch(`http://localhost:${port}/control/${p}`)).json();
  }
  async function ctlPost(p: string, body: unknown): Promise<any> {
    return (
      await fetch(`http://localhost:${port}/control/${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).json();
  }

  let proxy: ProxyHandle | undefined;
  const boot = (): ProxyHandle =>
    (proxy = startProxy({ port, upstreamBaseUrl: stub.baseUrl, storePath }));
  try {
    // turn 1: ingest + capture, then stop (await a control read to settle the capture)
    let p = boot();
    stub.enqueue({ text: "4", stopReason: "end_turn" });
    await send([userA]);
    await ctlGet("list"); // awaits the in-flight capture → persisted
    p.stop();

    // restart #1: persisted frames are back
    p = boot();
    const list = await ctlGet("list");
    expect(list.frames.map((f: any) => f.id)).toEqual(["p0", "t1"]);

    // delete → an implicit commit shows in history
    expect((await ctlPost("delete", { ids: ["t1"] })).deleted).toEqual(["t1"]);
    const hist = await ctlGet("history");
    expect(hist.commits).toHaveLength(1);
    expect(hist.commits[0].type).toBe("delete");
    expect(hist.commits[0].seq).toBeUndefined(); // internal clock not leaked over the API
    const deleteId = hist.commits[0].id;

    // the timeline (over the control API) shows the full chronology incl. captures,
    // and does not leak the internal seq
    const tl = await ctlGet("timeline");
    expect(tl.events.some((e: any) => e.type === "capture")).toBe(true);
    expect(tl.events.some((e: any) => e.type === "delete" && e.commitId === deleteId)).toBe(true);
    expect(tl.events[0].seq).toBeUndefined();
    p.stop();

    // restart #2: delete + commit survived; revert restores
    p = boot();
    expect((await ctlPost("revert", { commit: deleteId })).reverted.type).toBe("revert");

    // the next rewritten request reflects the reverted state: the unaware agent resends
    // the original content; compose now INCLUDES the restored frame.
    stub.enqueue({ text: "still 4", stopReason: "end_turn" });
    await send([userA]);
    const forwarded = (stub.received[stub.received.length - 1] as any).messages;
    expect(JSON.stringify(forwarded)).toContain("What is 2+2?"); // restored frame is back on the wire
  } finally {
    proxy?.stop();
    stub.stop();
  }
});
