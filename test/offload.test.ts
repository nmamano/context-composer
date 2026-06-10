// §11 Phase 3b acceptance — OFFLOAD/RESTORE (memory ops over the 3a
// representation machinery). The frame's emission becomes a short stub carrying
// an ABSOLUTE artifact path; the full pre-offload EMISSION (representation ??
// messages — not blindly the source) is rendered to disk for the wrapped agent
// to read back with its own file-read tool (provider assumption 5). Artifact
// filenames embed a content hash so a committed fileReference keeps pointing at
// the bytes rendered for THAT offload forever (append-only revert invariant).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { FrameStore } from "../src/engine/state.ts";
import { JsonFileStore } from "../src/engine/store.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
let framesDir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-off-"));
  framesDir = join(dir, "frames");
  storePath = join(dir, "store.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = { model: "m", max_tokens: 64, system: "SYS" };
// Distinctive content lives on line 2: the derived summary is the FIRST line,
// and the summary legitimately rides the stub onto the wire — assertions about
// "full text absent" must target content the summary doesn't carry.
const u1 = {
  role: "user",
  content:
    "the launch protocol details follow\n" +
    "step alpha, step beta, step gamma\n".repeat(8) +
    "end of protocol details",
};
const a1 = { role: "assistant", content: "protocol memorized in full" };

function mkStore(): FrameStore {
  return new FrameStore(null, "test", framesDir);
}
function wire(s: FrameStore): string {
  return JSON.stringify(s.compose().body);
}
function fileRef(s: FrameStore, id: string): string {
  return s.show(id)!.fileReference!;
}

// ── the core beat: stub + artifact, token drop, zero loss ────────────────────
test("offload: stub with absolute path emitted, full text on disk, tokens drop", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  const beforeTokens = s.show("t1")!.tokenEstimate;

  const r = s.offload("t1");
  expect(r.ok).toBe(true);

  // Emission: the stub, not the content.
  const w = wire(s);
  expect(w).toContain("[OFFLOADED FRAME t1]");
  expect(w).not.toContain("step alpha");
  // The stub path is absolute (the agent's cwd is not ours) and namespaced.
  const path = fileRef(s, "t1");
  expect(isAbsolute(path)).toBe(true);
  expect(path).toContain("test-t1-");
  expect(w).toContain(path);

  // The artifact holds the rendered emission; mode 0600; summary derived from
  // the first text line (deterministic, no LLM).
  const rendered = readFileSync(path, "utf8");
  expect(rendered).toContain("step alpha, step beta, step gamma");
  expect(rendered).toContain("protocol memorized in full");
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(w).toContain("Summary: the launch protocol details follow");

  // Token invariant: estimate tracks the stub now.
  expect(s.show("t1")!.tokenEstimate).toBeLessThan(beforeTokens);
  const summary = s.list().find((f) => f.id === "t1")!;
  expect(summary.offloaded).toBe(true);
  expect(summary.fileReference).toBe(path);
});

// ── source-vs-representation: the file renders what the model was SEEING ────
test("offloading an edited frame renders the EDIT to disk, not the source", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.edit("t1", { text: "the protocol, redacted to one line" });

  s.offload("t1");
  const rendered = readFileSync(fileRef(s, "t1"), "utf8");
  expect(rendered).toContain("redacted to one line");
  expect(rendered).not.toContain("step alpha"); // source stays store-only

  // restore() brings back the EDIT (the pre-offload emission), not the source.
  s.restore("t1");
  const w = wire(s);
  expect(w).toContain("redacted to one line");
  expect(w).not.toContain("step alpha");
  expect(w).not.toContain("[OFFLOADED FRAME");
  expect(s.show("t1")!.offloaded).toBe(false);
  expect(s.show("t1")!.fileReference).toBeNull();
});

// ── append-only invariant: repeat offloads never clobber committed bytes ────
test("re-offload after restore+edit writes a NEW artifact; the first one's bytes survive", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });

  s.offload("t1");
  const path1 = fileRef(s, "t1");
  const bytes1 = readFileSync(path1, "utf8");

  s.restore("t1");
  s.edit("t1", { text: "fully rewritten content" });
  s.offload("t1");
  const path2 = fileRef(s, "t1");

  expect(path2).not.toBe(path1); // content hash differs → different artifact
  expect(readFileSync(path1, "utf8")).toBe(bytes1); // first commit's bytes intact
  expect(readFileSync(path2, "utf8")).toContain("fully rewritten content");

  // Identical-content re-offload is idempotent: same hash → same path.
  s.restore("t1");
  s.offload("t1");
  expect(fileRef(s, "t1")).toBe(path2);
});

// ── revert interplay (reviewer point F) ──────────────────────────────────────
test("revert(offload) un-offloads; revert(restore) re-instates the stub AND its fileReference", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });

  const off = s.offload("t1");
  expect(off.ok).toBe(true);
  const path = fileRef(s, "t1");
  const res = s.restore("t1");
  expect(res.ok).toBe(true);
  expect(wire(s)).toContain("step alpha"); // inline again

  // Revert the restore: stub comes back, fileReference points at the SAME
  // committed artifact (content-hashed name — never overwritten).
  const r1 = s.revert();
  expect(r1.ok).toBe(true);
  expect(s.show("t1")!.offloaded).toBe(true);
  expect(s.show("t1")!.fileReference).toBe(path);
  expect(wire(s)).toContain(path);
  expect(readFileSync(path, "utf8")).toContain("step alpha");

  // Revert the offload commit itself: back to inline source emission.
  const r2 = s.revert((off as { ok: true; commit: { id: string } }).commit.id);
  expect(r2.ok).toBe(true);
  expect(s.show("t1")!.offloaded).toBe(false);
  expect(s.show("t1")!.fileReference).toBeNull();
  expect(wire(s)).toContain("step alpha");
  expect(wire(s)).not.toContain("[OFFLOADED FRAME");
});

// ── metadata coherence under revert (reviewer-caught drift class) ────────────
// Reverting an OLDER content commit while the frame is offloaded would swap the
// emission out from under the active offload: offloaded=true + fileReference
// set, but compose no longer emitting the stub. While offloaded, only the
// current offload commit is revertible.
test("revert(older edit) while offloaded is refused; state stays coherent", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [{ role: "user", content: "source secret" }] });
  const e = s.edit("t1", { text: "edited secret" });
  expect(e.ok).toBe(true);
  // Explicit summary: the derived one would be the edit's first line, which
  // legitimately rides the stub and would collide with the assertions below.
  s.offload("t1", { summary: "a record-keeping note" });
  const path = fileRef(s, "t1");

  const r = s.revert((e as { ok: true; commit: { id: string } }).commit.id);
  expect(r.ok).toBe(false);
  expect((r as { ok: false; error: string }).error).toContain("restore it first");

  // Coherent: still offloaded, stub still the emission, artifact unchanged.
  expect(s.show("t1")!.offloaded).toBe(true);
  expect(s.show("t1")!.fileReference).toBe(path);
  const w = wire(s);
  expect(w).toContain("[OFFLOADED FRAME t1]");
  expect(w).not.toContain("source secret");
  expect(w).not.toContain("edited secret");

  // After restore, the same revert is legal again (normal 3a semantics).
  s.restore("t1");
  const r2 = s.revert((e as { ok: true; commit: { id: string } }).commit.id);
  expect(r2.ok).toBe(true);
  expect(wire(s)).toContain("source secret");
});

test("revert(older restore/offload) while re-offloaded is refused; current offload commit is revertible", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  const off1 = s.offload("t1");
  const res1 = s.restore("t1");
  s.edit("t1", { text: "second life content" });
  const off2 = s.offload("t1");
  const path2 = fileRef(s, "t1");

  // Neither the older offload nor the older restore may be reverted now —
  // both would silently swap the active offload's stub/fileReference.
  const rOff1 = s.revert((off1 as { ok: true; commit: { id: string } }).commit.id);
  expect(rOff1.ok).toBe(false);
  const rRes1 = s.revert((res1 as { ok: true; commit: { id: string } }).commit.id);
  expect(rRes1.ok).toBe(false);
  expect(s.show("t1")!.fileReference).toBe(path2); // untouched

  // The CURRENT offload commit is the one deliberate escape hatch.
  const rOff2 = s.revert((off2 as { ok: true; commit: { id: string } }).commit.id);
  expect(rOff2.ok).toBe(true);
  expect(s.show("t1")!.offloaded).toBe(false);
  expect(wire(s)).toContain("second life content"); // the pre-offload edit emits again
});

// ── guards ────────────────────────────────────────────────────────────────────
test("guards: offloaded frames refuse edit/compact/offload; restore needs an offload; deleted/preamble refused", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.offload("t1");

  const e = s.edit("t1", { text: "x" });
  expect(e.ok).toBe(false);
  expect((e as { ok: false; error: string }).error).toContain("restore it first");
  const c = s.compact("t1", { text: "x" });
  expect(c.ok).toBe(false);
  const o = s.offload("t1");
  expect(o.ok).toBe(false);
  expect((o as { ok: false; error: string }).error).toContain("already offloaded");

  const r = s.restore("t99");
  expect(r.ok).toBe(false);
  s.restore("t1");
  const r2 = s.restore("t1");
  expect(r2.ok).toBe(false);
  expect((r2 as { ok: false; error: string }).error).toContain("not offloaded");

  const p = s.offload("p0");
  expect(p.ok).toBe(false);
  expect((p as { ok: false; error: string }).error).toContain("deferred");

  s.delete(["t1"]);
  const d = s.offload("t1");
  expect(d.ok).toBe(false);
  expect((d as { ok: false; error: string }).error).toContain("deleted");
});

test("summary: manual --summary wins; no-text emission falls back to 'offloaded frame <id>'", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1] });
  s.offload("t1", { summary: "the launch protocol (manual)" });
  expect(wire(s)).toContain("Summary: the launch protocol (manual)");
  s.restore("t1");

  // A frame whose emission has no text blocks at all (raw-edited to tool-only
  // content would be swept; use an image-style block to stay un-swept).
  s.edit("t1", { raw: [{ role: "user", content: [{ type: "image", source: { data: "xx" } }] }] });
  s.offload("t1");
  expect(wire(s)).toContain("Summary: offloaded frame t1");
});

// ── durability: snapshot v4 round-trip ───────────────────────────────────────
test("offload state survives a restart: stub, flags, fileReference, readable artifact", () => {
  const s1 = new FrameStore(new JsonFileStore(storePath), "test", framesDir);
  s1.ingest({ ...HEAD, messages: [u1, a1] });
  s1.offload("t1");
  const path = fileRef(s1, "t1");

  const s2 = new FrameStore(new JsonFileStore(storePath), "test", framesDir);
  expect(s2.show("t1")!.offloaded).toBe(true);
  expect(s2.show("t1")!.fileReference).toBe(path);
  expect(JSON.stringify(s2.compose().body)).toContain(path);
  expect(readFileSync(path, "utf8")).toContain("step alpha");

  // The resend still matches (identity from source) and the stub still wins.
  s2.ingest({ ...HEAD, messages: [u1, a1, { role: "user", content: "next" }] });
  expect(s2.list().filter((f) => f.kind === "turn")).toHaveLength(2);
  const w = JSON.stringify(s2.compose().body);
  expect(w).toContain("[OFFLOADED FRAME t1]");
  expect(w).not.toContain("step alpha");
});

// ── proxy e2e: the path on the wire resolves to the right bytes ──────────────
test("through the proxy: outbound stub path is absolute and the artifact matches the pre-offload emission", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, framesDir });
    const base = `http://localhost:${proxy.port}`;
    const send = async (body: unknown) => {
      await (await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).text();
      await fetch(`${base}/control/list`);
    };

    stub.enqueue({ text: "noted", stopReason: "end_turn" });
    await send({ ...HEAD, messages: [u1] });

    // Edit FIRST, then offload — so a source-vs-representation mix-up in the
    // render path produces different file bytes and fails this test.
    await fetch(`${base}/control/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t1", text: "edited protocol note\nEDITED EMISSION for offload" }),
    });
    const off = (await (await fetch(`${base}/control/offload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "t1" }),
    })).json()) as any;
    expect(off.commit.type).toBe("offload");

    stub.enqueue({ text: "ok", stopReason: "end_turn" });
    await send({
      ...HEAD,
      messages: [u1, { role: "assistant", content: "noted" }, { role: "user", content: "follow-up" }],
    });

    const outbound = JSON.stringify(stub.received[1]);
    const match = outbound.match(/on disk at (\/[^ ]+\.md)/);
    expect(match).not.toBeNull();
    const path = match![1]!;
    expect(isAbsolute(path)).toBe(true);
    const rendered = readFileSync(path, "utf8");
    expect(rendered).toContain("EDITED EMISSION for offload"); // representation…
    expect(rendered).not.toContain("step alpha"); // …never the source
    expect(outbound).not.toContain("EDITED EMISSION"); // stub replaced it on the wire
    expect(outbound).toContain("follow-up");
  } finally {
    proxy?.stop();
    stub.stop();
  }
});
