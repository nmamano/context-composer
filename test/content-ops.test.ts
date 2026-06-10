// §11 Phase 3a acceptance — CONTENT OPS (edit/compact as representation
// overrides). The structural rule under test: a frame's SOURCE `messages` are
// authoritative for identity + reconcile refresh and are never touched by an op;
// the REPRESENTATION override is what compose emits. The Appendix C refresh-gate
// therefore holds by construction — the unaware agent's resend can refresh source
// all it wants, the emission stays the user's. North star: validity is a
// constraint; zero-loss and free-editability are the goals.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameStore } from "../src/engine/state.ts";
import { JsonFileStore } from "../src/engine/store.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
let storePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-ops-"));
  storePath = join(dir, "store.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = { model: "m", max_tokens: 64, system: "SYS" };
const u1 = { role: "user", content: "the secret plan is OMEGA-9, a very long tangent about it" };
const a1 = { role: "assistant", content: "understood, OMEGA-9 noted" };
const u2 = { role: "user", content: "next question" };

function reopen(): FrameStore {
  return new FrameStore(new JsonFileStore(storePath));
}
function wire(store: FrameStore): string {
  return JSON.stringify(store.compose().body);
}

// ── edit: emission replaced, source intact, resend cannot clobber ────────────
test("edit --text replaces the emission; the unaware resend never clobbers it", () => {
  const s = new FrameStore(null);
  s.ingest({ ...HEAD, messages: [u1, a1] });

  const r = s.edit("t1", { text: "(redacted tangent)" });
  expect(r.ok).toBe(true);

  // Emission is the override; source is fully intact (zero loss).
  expect(wire(s)).toContain("(redacted tangent)");
  expect(wire(s)).not.toContain("OMEGA-9");
  expect(JSON.stringify(s.show("t1")!.messages)).toContain("OMEGA-9");

  // The unaware agent resends the ORIGINAL content + a new turn. Reconcile
  // refreshes source; the override must survive untouched.
  s.ingest({ ...HEAD, messages: [u1, a1, u2] });
  const w = wire(s);
  expect(w).toContain("(redacted tangent)");
  expect(w).not.toContain("OMEGA-9");
  expect(w).toContain("next question");
  // Single frame for t1 — the matcher saw the same source identity (no fork).
  expect(s.list().filter((f) => f.kind === "turn")).toHaveLength(2);
});

test("editing a tail frame leaves the head hash unchanged (cache duty intact)", () => {
  const s = new FrameStore(null);
  s.ingest({ ...HEAD, messages: [u1, a1] });
  const before = s.compose().headHash;
  expect(s.edit("t1", { text: "edited" }).ok).toBe(true);
  expect(s.compose().headHash).toBe(before);
});

// ── token accounting (reviewer point 1 — the main required change) ───────────
test("tokenEstimate tracks the EMITTED representation across op, resend, and restart", () => {
  const s = reopen();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  const sourceTokens = s.show("t1")!.tokenEstimate;

  s.compact("t1", { text: "tiny" });
  const compactTokens = s.show("t1")!.tokenEstimate;
  expect(compactTokens).toBeLessThan(sourceTokens);

  // The unaware resend refreshes source — the estimate must NOT snap back to
  // the source size (list/conversations would count the tangent as live again).
  s.ingest({ ...HEAD, messages: [u1, a1, u2] });
  expect(s.show("t1")!.tokenEstimate).toBe(compactTokens);

  // And it survives a restart.
  const s2 = reopen();
  expect(s2.show("t1")!.tokenEstimate).toBe(compactTokens);
});

// ── restart: override + identity survive (the restore trap) ──────────────────
test("override survives restart; identity does not fork (anchor recomputes from source)", () => {
  const s1 = reopen();
  s1.ingest({ ...HEAD, messages: [u1, a1] });
  s1.edit("t1", { text: "edited away" });

  const s2 = reopen(); // restart: anchorFp recomputed from SOURCE messages[0]
  expect(JSON.stringify(s2.compose().body)).toContain("edited away");
  expect(s2.list().find((f) => f.id === "t1")!.overridden).toBe(true);

  // The resend still matches the restored frame — no duplicate, edit still wins.
  s2.ingest({ ...HEAD, messages: [u1, a1, u2] });
  expect(s2.list().filter((f) => f.kind === "turn")).toHaveLength(2);
  expect(JSON.stringify(s2.compose().body)).not.toContain("OMEGA-9");
});

// ── compact: role preservation (reviewer point 2) ─────────────────────────────
test("compact preserves the frame opener's role (assistant-opened frame stays assistant)", () => {
  const s = new FrameStore(null);
  // An assistant-opening frame (possible in the model and via raw paths).
  s.ingest({ ...HEAD, messages: [{ role: "assistant", content: "I begin" }] });
  const frame = s.list().find((f) => f.kind === "turn")!;
  expect(s.compact(frame.id, { text: "summary of opening" }).ok).toBe(true);
  const rep = s.show(frame.id)!.representation!;
  expect(rep).toEqual([{ role: "assistant", content: "summary of opening" }]);

  // And a user-opened frame stays user.
  s.ingest({ ...HEAD, messages: [{ role: "assistant", content: "I begin" }, u2] });
  s.compact("t2", { text: "user summary" });
  expect(s.show("t2")!.representation).toEqual([{ role: "user", content: "user summary" }]);
});

// ── commits, provenance, revert breadth (reviewer point 6) ────────────────────
test("edit/compact are commits; revert restores the prior representation only", () => {
  const s = new FrameStore(null);
  s.ingest({ ...HEAD, messages: [u1, a1] });

  const e1 = s.edit("t1", { text: "first edit" });
  const e2 = s.compact("t1", { text: "then compacted" });
  expect(e1.ok && e2.ok).toBe(true);
  expect(s.history().map((c) => c.type)).toEqual(["edit", "compact"]);
  expect(s.show("t1")!.provenance).toHaveLength(2);

  // Revert the compact (HEAD): representation returns to the edit.
  const r1 = s.revert();
  expect(r1.ok).toBe(true);
  expect(s.show("t1")!.representation).toEqual([{ role: "user", content: "first edit" }]);
  // Source messages untouched throughout.
  expect(JSON.stringify(s.show("t1")!.messages)).toContain("OMEGA-9");

  // Double-revert guard applies to content commits like delete commits.
  const r2 = s.revert((e2 as { ok: true; commit: { id: string } }).commit.id);
  expect(r2.ok).toBe(false);
  expect((r2 as { ok: false; error: string }).error).toContain("already reverted");

  // Reverting the original edit restores `before: null` — no override at all.
  const r3 = s.revert((e1 as { ok: true; commit: { id: string } }).commit.id);
  expect(r3.ok).toBe(true);
  expect(s.show("t1")!.representation ?? null).toBeNull();
  expect(JSON.stringify(s.compose().body)).toContain("OMEGA-9"); // source emits again
});

// ── capture-vs-override edge (reviewer point 8 — will surprise someone) ──────
test("a reply captured onto an overridden frame is stored (zero loss) but not emitted", () => {
  const s = new FrameStore(null);
  const v = s.ingest({ ...HEAD, messages: [u1] });
  s.edit("t1", { text: "edited before the reply landed" });

  s.captureAssistant(
    { message: { role: "assistant", content: [{ type: "text", text: "LATE REPLY" }] }, stopReason: "end_turn" },
    v.openFrameId,
  );

  // Authorship wins: the override is emitted, the reply is not…
  const w = wire(s);
  expect(w).toContain("edited before the reply landed");
  expect(w).not.toContain("LATE REPLY");
  // …but nothing is lost: the reply is in the source, visible via show.
  expect(JSON.stringify(s.show("t1")!.messages)).toContain("LATE REPLY");
});

// ── guards ────────────────────────────────────────────────────────────────────
test("edit/compact guards: preamble deferred (not semantic), deleted frames refused, missing frames refused", () => {
  const s = new FrameStore(null);
  s.ingest({ ...HEAD, messages: [u1] });

  const p = s.edit("p0", { text: "nope" });
  expect(p.ok).toBe(false);
  expect((p as { ok: false; error: string }).error).toContain("not yet supported");
  expect((p as { ok: false; error: string }).error).toContain("deferred");

  s.delete(["t1"]);
  const d = s.compact("t1", { text: "nope" });
  expect(d.ok).toBe(false);
  expect((d as { ok: false; error: string }).error).toContain("deleted");

  expect(s.edit("t99", { text: "x" }).ok).toBe(false);
});

test("--raw validation: rejects non-WireMessage[] shapes, deep-clones accepted input", () => {
  const s = new FrameStore(null);
  s.ingest({ ...HEAD, messages: [u1] });
  expect(s.edit("t1", { raw: [] as never }).ok).toBe(false);
  expect(s.edit("t1", { raw: [{ role: "system", content: "x" }] as never }).ok).toBe(false);
  expect(s.edit("t1", { raw: [{ role: "user" }] as never }).ok).toBe(false);

  const raw = [{ role: "user" as const, content: [{ type: "text", text: "owned" }] }];
  expect(s.edit("t1", { raw }).ok).toBe(true);
  raw[0]!.content[0]!.text = "MUTATED AFTER STORE"; // caller mutation must not reach the store
  expect(JSON.stringify(s.compose().body)).toContain("owned");
  expect(JSON.stringify(s.compose().body)).not.toContain("MUTATED AFTER STORE");
});

// ── 2.7 interaction: views and overrides compose orthogonally ────────────────
test("an edited frame emits its override within the request view; deleted still wins; fork frames stay editable", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
    const base = `http://localhost:${proxy.port}`;
    const send = async (body: unknown) => {
      await (await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).text();
      await fetch(`${base}/control/list`);
    };

    stub.enqueue({ text: "r1", stopReason: "end_turn" });
    await send({ ...HEAD, messages: [{ role: "user", content: "hello main" }] });
    // A fork rides in (same opening message → collided key) and stays stored.
    stub.enqueue({ text: "fork reply", stopReason: "end_turn" });
    await send({
      ...HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "EPHEMERAL fork" },
      ],
    });

    // Edit the MAIN frame through the control API, then a fork-only frame too —
    // fork frames are ordinary frames (visible, editable, deletable).
    const edit = async (id: string, text: string) =>
      (await (await fetch(`${base}/control/edit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, text }),
      })).json()) as { commit?: { type: string }; error?: string };
    expect((await edit("t1", "EDITED MAIN")).commit?.type).toBe("edit");
    expect((await edit("t2", "EDITED FORK")).commit?.type).toBe("edit");

    // Next main turn: emits the main override inside the view; the fork frame
    // (edited or not) stays off this wire.
    stub.enqueue({ text: "r2", stopReason: "end_turn" });
    await send({
      ...HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "second main" },
      ],
    });
    const w = JSON.stringify(stub.received[2]);
    expect(w).toContain("EDITED MAIN");
    expect(w).not.toContain("hello main"); // override replaced the source emission
    expect(w).not.toContain("EDITED FORK"); // fork isolation unaffected by edits
    expect(w).toContain("second main");

    // Deleted still wins over an override: tombstone the edited frame and the
    // next resend emits NEITHER the source nor the edit.
    await fetch(`${base}/control/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["t1"] }),
    });
    stub.enqueue({ text: "r3", stopReason: "end_turn" });
    await send({
      ...HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "second main" },
        { role: "assistant", content: "r2" },
        { role: "user", content: "third main" },
      ],
    });
    const w2 = JSON.stringify(stub.received[3]);
    expect(w2).not.toContain("EDITED MAIN");
    expect(w2).not.toContain("hello main");
    expect(w2).toContain("third main");
  } finally {
    proxy?.stop();
    stub.stop();
  }
});
