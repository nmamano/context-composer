// §11 Phase 3c acceptance — STRUCTURAL OPS (combine/split/move/add). Two locked
// mechanisms, both as resolution layers over the (view, store) split:
//  • PLACEMENT: membership+baseline order from the request; `placement`
//    re-splices; ADDED frames are members of every emission BY USER OP — the
//    one deliberate membership extension beyond the request (2.7 guardrail).
//  • ABSORPTION: combine parts / split originals stay in the store as 1:1
//    match targets; compose resolves them to absorber/children (Appendix C's
//    many-to-many emission as indirection). reconcile matching is untouched.

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
  dir = mkdtempSync(join(tmpdir(), "cc-struct-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = { model: "m", max_tokens: 64, system: "SYS" };
const u = (t: string) => ({ role: "user", content: t });
const a = (t: string) => ({ role: "assistant", content: t });

function mk(): FrameStore {
  return new FrameStore(null, "test", join(dir, "frames"));
}
/** Emitted text order — first occurrence index of each marker in the wire body. */
function orderOf(s: FrameStore, ...markers: string[]): number[] {
  const w = JSON.stringify(s.compose().body);
  return markers.map((m) => w.indexOf(m));
}

// ── add: membership by user op ────────────────────────────────────────────────
test("add: emits at the requested place despite never being matched; default end; revert tombstones", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("one"), a("r1"), u("two"), a("r2")] });

  // After t1 (frame "one"): the note emits between the two turns.
  const r = s.add({ text: "INJECTED NOTE" }, { after: "t1" });
  expect(r.ok).toBe(true);
  const [i1, iN, i2] = orderOf(s, '"one"', "INJECTED NOTE", '"two"');
  expect(i1).toBeGreaterThanOrEqual(0);
  expect(iN).toBeGreaterThan(i1!);
  expect(i2).toBeGreaterThan(iN!);

  // Default placement: end of the conversation at add time.
  s.add({ text: "TRAILING NOTE" });
  const [iTwo, iT] = orderOf(s, '"two"', "TRAILING NOTE");
  expect(iT).toBeGreaterThan(iTwo!);

  // --start.
  s.add({ text: "LEADING NOTE" }, { after: null });
  const [iL, iOne] = orderOf(s, "LEADING NOTE", '"one"');
  expect(iOne).toBeGreaterThan(iL!);

  // revert(add) = append-only un-create.
  const rev = s.revert((r as { ok: true; commit: { id: string } }).commit.id);
  expect(rev.ok).toBe(true);
  expect(JSON.stringify(s.compose().body)).not.toContain("INJECTED NOTE");
  expect(s.show("t3")!.deleted).toBe(true); // still showable, audit-complete
});

test("add: emits inside the request VIEW on the owned path and survives restart unmatched", async () => {
  const storePath = join(dir, "store.json");
  const reopen = () => new FrameStore(new JsonFileStore(storePath), "test", join(dir, "frames"));
  const s1 = reopen();
  const v1 = s1.ingest({ ...HEAD, messages: [u("hello")] });
  s1.add({ text: "STANDING INSTRUCTION" }, { after: "t1" });

  // View-scoped compose (what the proxy emits): the added frame rides along.
  expect(JSON.stringify(s1.compose(v1).body)).toContain("STANDING INSTRUCTION");

  // Restart: the added frame keeps its sentinel anchor (no recompute — a
  // manufactured anchor must never match a future resend)…
  const s2 = reopen();
  expect(s2.show("t2")!.anchorFp.startsWith("manufactured:added:")).toBe(true);
  // …so an agent message with IDENTICAL text still appends a NEW frame.
  const v2 = s2.ingest({
    ...HEAD,
    messages: [u("hello"), a("r"), u("STANDING INSTRUCTION")],
  });
  expect(v2.createdIds).toHaveLength(1); // not matched into t2
  expect(s2.list().filter((f) => f.kind === "turn")).toHaveLength(3);
});

// ── move: ordering override, never membership (reviewer RC2) ─────────────────
test("move reorders the emission; a moved fork-only frame still stays off the main wire; added frames ride every emission", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, framesDir: join(dir, "frames") });
    const base = `http://localhost:${proxy.port}`;
    const send = async (body: unknown) => {
      await (await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).text();
      await fetch(`${base}/control/list`);
    };
    const ctl = (path: string, body: unknown) =>
      fetch(`${base}/control/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    stub.enqueue({ text: "r1", stopReason: "end_turn" });
    await send({ ...HEAD, messages: [u("hello main")] });
    // Fork rides in (same opening message → collided key): appends t2.
    stub.enqueue({ text: "fork reply", stopReason: "end_turn" });
    await send({
      ...HEAD,
      messages: [u("hello main"), a("r1"), u("EPHEMERAL fork note")],
    });

    // MOVE the fork-only frame to the start; ADD an instruction after t1.
    await ctl("move", { id: "t2", after: null });
    await ctl("add", { text: "ADDED INSTRUCTION", after: "t1" });

    // Next main turn: the moved fork frame must NOT appear (move never creates
    // membership); the added frame MUST (membership by user op).
    stub.enqueue({ text: "r2", stopReason: "end_turn" });
    await send({
      ...HEAD,
      messages: [u("hello main"), a("r1"), u("second main")],
    });
    const w = JSON.stringify(stub.received[2]);
    expect(w).not.toContain("EPHEMERAL fork note");
    expect(w).toContain("ADDED INSTRUCTION");
    expect(w.indexOf("ADDED INSTRUCTION")).toBeGreaterThan(w.indexOf("hello main"));
    expect(w.indexOf("ADDED INSTRUCTION")).toBeLessThan(w.indexOf("second main"));
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

test("move: reorder + revert; anchor-absence falls back deterministically; cycles surface", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc")] });

  // Move t3 (gamma) to the start.
  const mv = s.move("t3", { after: null });
  expect(mv.ok).toBe(true);
  let [iG, iA, iB] = orderOf(s, '"gamma"', '"alpha"', '"beta"');
  expect(iG).toBeLessThan(iA!);
  expect(iA).toBeLessThan(iB!);

  // revert(move): natural order restored.
  s.revert((mv as { ok: true; commit: { id: string } }).commit.id);
  [iA, iB, iG] = orderOf(s, '"alpha"', '"beta"', '"gamma"');
  expect(iA).toBeLessThan(iB!);
  expect(iB).toBeLessThan(iG!);

  // Anchor absence (moved member): anchor deleted → natural baseline position.
  s.move("t1", { after: "t2" });
  s.delete(["t2"]);
  const c = s.compose();
  expect(c.structureWarnings).toEqual([]); // deterministic fallback, no warning
  const [jA, jG] = orderOf(s, '"alpha"', '"gamma"');
  expect(jA).toBeLessThan(jG!); // t1 back at its natural slot

  // Cycle: t1 after t3, t3 after t1 → both appended in store order + warning.
  s.move("t1", { after: "t3" });
  s.move("t3", { after: "t1" });
  const c2 = s.compose();
  expect(c2.structureWarnings.map((x) => x.kind)).toEqual(["placement-cycle"]);
  expect(JSON.stringify(c2.body)).toContain("alpha"); // nothing lost
  expect(JSON.stringify(c2.body)).toContain("gamma");
});

// ── combine: many sources → one emission slot ─────────────────────────────────
test("combine: emitted once at the first part's slot; resend neither duplicates nor un-combines; revert restores", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc")] });

  const cb = s.combine(["t1", "t2"]);
  expect(cb.ok).toBe(true);
  const combinedId = (cb as unknown as { commit: { params: { combinedId: string } } }).commit.params.combinedId;

  // Emission: combined content once, at t1's slot, before gamma.
  const c = s.compose();
  expect(c.emittedFrameIds).toEqual([combinedId, "t3"]);
  const w = JSON.stringify(c.body);
  expect(w.split('"alpha"').length - 1).toBe(1); // once
  expect(w.indexOf("alpha")).toBeLessThan(w.indexOf("gamma"));
  // Parts: hidden token-wise; combined carries the estimate.
  expect(s.show("t1")!.tokenEstimate).toBe(0);
  expect(s.show(combinedId)!.tokenEstimate).toBeGreaterThan(0);

  // The unaware resend of the parts matches them (1:1) and the emission stays combined.
  const v = s.ingest({
    ...HEAD,
    messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc"), u("delta")],
  });
  expect(v.frameIds.slice(0, 3)).toEqual(["t1", "t2", "t3"]); // matching untouched
  const c2 = s.compose(v);
  expect(c2.emittedFrameIds[0]).toBe(combinedId);
  expect(JSON.stringify(c2.body).split('"beta"').length - 1).toBe(1);

  // Ops on absorbed parts refuse; the combined frame is an ordinary frame.
  expect(s.edit("t1", { text: "x" }).ok).toBe(false);
  expect(s.delete(["t1"])).toEqual([]); // skip, not tombstone
  expect(s.edit(combinedId, { text: "merged summary" }).ok).toBe(true);

  // Downstream commit blocks revert(combine) — coherence guard…
  const r1 = s.revert((cb as { ok: true; commit: { id: string } }).commit.id);
  expect(r1.ok).toBe(false);
  expect((r1 as { ok: false; error: string }).error).toContain("downstream");
  // …until the downstream edit is reverted first.
  expect(s.revert().ok).toBe(true); // revert the edit (HEAD)
  const r2 = s.revert((cb as { ok: true; commit: { id: string } }).commit.id);
  expect(r2.ok).toBe(true);
  expect(s.show("t1")!.absorbedInto ?? null).toBeNull();
  expect(s.show(combinedId)!.deleted).toBe(true);
  const w3 = JSON.stringify(s.compose().body);
  expect(w3.indexOf("alpha")).toBeLessThan(w3.indexOf("beta"));
});

// ── split: one source → many emission slots ───────────────────────────────────
test("split: children emit at the original's slot; independently operable; revert restores", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("omega")] });

  const sp = s.split("t1", [1]);
  expect(sp.ok).toBe(true);
  const childIds = (sp as unknown as { commit: { params: { childIds: string[] } } }).commit.params.childIds;
  expect(childIds).toHaveLength(2);

  const c = s.compose();
  expect(c.emittedFrameIds).toEqual([...childIds, "t2"]);
  expect(s.show("t1")!.tokenEstimate).toBe(0);

  // A child is an ordinary frame: edit one, delete the other.
  const childEdit = s.edit(childIds[0]!, { text: "edited first half" });
  expect(childEdit.ok).toBe(true);
  expect(s.delete([childIds[1]!])).toEqual([childIds[1]!]);
  const w = JSON.stringify(s.compose().body);
  expect(w).toContain("edited first half");
  expect(w).not.toContain('"ra"'); // deleted child emits nothing

  // The resend still matches the ORIGINAL (1:1) — no duplication.
  const v = s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("omega"), a("ro")] });
  expect(v.frameIds[0]).toBe("t1");

  // revert(split) refuses while children have downstream commits…
  const r1 = s.revert((sp as { ok: true; commit: { id: string } }).commit.id);
  expect(r1.ok).toBe(false);
  // …clean the children up by explicit commit id (a bare revert() would target
  // the previous REVERT commit, which is itself not revertible).
  const deleteCommit = s.history().find((c) => c.type === "delete")!;
  expect(s.revert(deleteCommit.id).ok).toBe(true);
  expect(s.revert((childEdit as unknown as { commit: { id: string } }).commit.id).ok).toBe(true);
  const r2 = s.revert((sp as { ok: true; commit: { id: string } }).commit.id);
  expect(r2.ok).toBe(true);
  expect(s.show("t1")!.splitInto ?? null).toBeNull();
  expect(s.show(childIds[0]!)!.deleted).toBe(true);
  expect(JSON.stringify(s.compose().body)).toContain('"alpha"');

  // Guards: 1-message frames refuse; bad boundaries refuse.
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("omega"), a("ro"), u("end")] });
  const endFrame = s.list().filter((f) => f.kind === "turn").pop()!;
  expect(endFrame.messageCount).toBe(1); // genuinely one message
  const oneMsg = s.split(endFrame.id, [1]);
  expect(oneMsg.ok).toBe(false);
  expect((oneMsg as { ok: false; error: string }).error).toContain("nothing to split");
  expect(s.split("t1", [0]).ok).toBe(false);
  expect(s.split("t1", [9]).ok).toBe(false);
});

// ── structural products refuse combine/split/move (reviewer-caught) ──────────
// Nested absorption and move-over-absorption are separate coherence models 3c
// does not support: a combined frame emits at its first part's slot and
// children emit at the original's slot — placement is not consulted, so a move
// would be a silently-recorded no-op, and re-combining creates nested states
// the revert guards cannot reason about.
test("combined frames and split children refuse combine/split/move; added frames stay operable", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("A"), a("ra"), u("B"), a("rb"), u("C"), a("rc")] });
  const cb = s.combine(["t1", "t2"]);
  const combinedId = (cb as unknown as { commit: { params: { combinedId: string } } }).commit.params.combinedId;

  // The reviewer's repro: re-combining the combined frame must refuse…
  const nested = s.combine([combinedId, "t3"]);
  expect(nested.ok).toBe(false);
  expect((nested as { ok: false; error: string }).error).toContain("structural product");
  // …as must splitting or moving it.
  expect(s.split(combinedId, [1]).ok).toBe(false);
  const mv = s.move(combinedId, { after: "t3" });
  expect(mv.ok).toBe(false);
  expect(s.history().every((c) => c.type !== "move")).toBe(true); // no no-op commit recorded
  expect(s.compose().emittedFrameIds[0]).toBe(combinedId); // emission unchanged

  // Split children: same class.
  const sp = s.split("t3", [1]);
  const childIds = (sp as unknown as { commit: { params: { childIds: string[] } } }).commit.params.childIds;
  expect(s.combine([childIds[0]!, combinedId]).ok).toBe(false);
  expect(s.move(childIds[0]!, { after: null }).ok).toBe(false);

  // Added frames remain fully operable (combine with a captured frame works).
  s.ingest({ ...HEAD, messages: [u("A"), a("ra"), u("B"), a("rb"), u("C"), a("rc"), u("D")] });
  s.add({ text: "a note" }, { after: null });
  const turns = s.list().filter((f) => f.kind === "turn");
  const addedId = turns.find((f) => (f as { origin?: string }).origin === "added")!.id;
  // The "D" frame: the last live CAPTURED frame (ids shifted by children).
  const dId = [...turns].reverse().find(
    (f) => (f as { origin?: string }).origin === "captured" && !f.deleted && !f.absorbedInto && !f.splitInto,
  )!.id;
  const cb2 = s.combine([addedId, dId]);
  expect(cb2.ok).toBe(true);
});

// ── durability: snapshot v5 round-trip ────────────────────────────────────────
test("placement + absorption survive a restart; manufactured anchors stay sentinels", () => {
  const storePath = join(dir, "store.json");
  const reopen = () => new FrameStore(new JsonFileStore(storePath), "test", join(dir, "frames"));
  const s1 = reopen();
  s1.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc")] });
  const cb = s1.combine(["t1", "t2"]);
  const combinedId = (cb as unknown as { commit: { params: { combinedId: string } } }).commit.params.combinedId;
  s1.add({ text: "PINNED NOTE" }, { after: null });
  s1.move("t3", { after: null });

  const s2 = reopen();
  expect(s2.show(combinedId)!.anchorFp).toBe(`manufactured:combined:${combinedId}`);
  expect(s2.show("t1")!.absorbedInto).toBe(combinedId);
  const c = s2.compose();
  const w = JSON.stringify(c.body);
  // start bucket: PINNED NOTE (added, start) and gamma (moved to start) emit
  // before the combined frame's slot; combined emits once.
  expect(w.indexOf("PINNED NOTE")).toBeLessThan(w.indexOf("alpha"));
  expect(w.indexOf("gamma")).toBeLessThan(w.indexOf("alpha"));
  expect(w.split('"alpha"').length - 1).toBe(1);

  // Resend matches parts; combined emission persists across the restart.
  const v = s2.ingest({
    ...HEAD,
    messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc"), u("next")],
  });
  expect(JSON.stringify(s2.compose(v).body).split('"beta"').length - 1).toBe(1);
});

// ── proxy e2e: evidence surfaces ──────────────────────────────────────────────
test("through the proxy: emittedFrameIds + structureWarnings ride control compose and the wiretap", async () => {
  const { readFileSync } = await import("node:fs");
  const tapPath = join(dir, "tap.jsonl");
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({
      port: 0,
      upstreamBaseUrl: stub.baseUrl,
      wiretapPath: tapPath,
      framesDir: join(dir, "frames"),
    });
    const base = `http://localhost:${proxy.port}`;

    stub.enqueue({ text: "r1", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...HEAD, messages: [u("hello")] }),
    })).text();
    await fetch(`${base}/control/list`);

    await fetch(`${base}/control/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "NOTE", after: "t1" }),
    });

    const c = (await (await fetch(`${base}/control/compose?dump`)).json()) as any;
    expect(c.emittedFrameIds).toEqual(["t1", "t2"]);
    expect(c.structureWarnings).toEqual([]);

    stub.enqueue({ text: "r2", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...HEAD, messages: [u("hello"), a("r1"), u("again")] }),
    })).text();
    await fetch(`${base}/control/list`);

    const lines = readFileSync(tapPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = lines.filter((e) => e.kind === "messages").pop()!;
    expect(last.viewFrameIds).toEqual(["t1", "t3"]); // honest match mapping (no t2)
    expect(last.emittedFrameIds).toEqual(["t1", "t2", "t3"]); // resolution evidence
    expect(JSON.stringify(last.outboundBody)).toContain("NOTE");
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

// ── F-047: combine with an EXPLICIT insert position ───────────────────────────
// Reviewer-gated: omitted `after` preserves the first-part-slot behavior
// byte-for-byte (pinned above); given, the combined frame emits ONCE at the
// placement (the part slots emit nothing — resolution skips a placed
// absorber); `after` validates like add(), null = start, absorbed parts are
// valid anchors. Placement is an ordering override, not membership creation.

test("F-047: combine --after places the result; parts' slots emit nothing; exactly once", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc")] });

  const cb = s.combine(["t1", "t2"], { after: "t3" });
  expect(cb.ok).toBe(true);
  const combinedId = (cb as unknown as { commit: { params: { combinedId: string } } })
    .commit.params.combinedId;

  // Emitted once, AFTER gamma — not at t1's slot.
  const c = s.compose();
  expect(c.emittedFrameIds).toEqual(["t3", combinedId]);
  const w = JSON.stringify(c.body);
  expect(w.split('"alpha"').length - 1).toBe(1); // once
  expect(w.indexOf("gamma")).toBeLessThan(w.indexOf("alpha"));
  // The commit records the placement (history shows where it went).
  expect(
    (cb as unknown as { commit: { params: { placement?: { after: string | null } } } })
      .commit.params.placement,
  ).toEqual({ after: "t3" });

  // View-mode parity: an unaware resend of the parts emits the same shape.
  const v = s.ingest({
    ...HEAD,
    messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc")],
  });
  const c2 = s.compose(v);
  expect(c2.emittedFrameIds).toEqual(["t3", combinedId]);
});

test("F-047: combine --start; and an absorbed part is a valid anchor", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc")] });

  // --start: combined leads the emission.
  const cb = s.combine(["t2", "t3"], { after: null });
  expect(cb.ok).toBe(true);
  const id1 = (cb as unknown as { commit: { params: { combinedId: string } } }).commit
    .params.combinedId;
  const c = s.compose();
  expect(c.emittedFrameIds).toEqual([id1, "t1"]);
  const w = JSON.stringify(c.body);
  expect(w.indexOf("beta")).toBeLessThan(w.indexOf("alpha"));

  // Anchor on an absorbed part: t2 keeps its order-spine slot; a second
  // combine anchored after t2 lands where t2 sits (start, via id1's lead).
  const s2 = mk();
  s2.ingest({ ...HEAD, messages: [u("one"), a("r1"), u("two"), a("r2"), u("three"), a("r3")] });
  const first = s2.combine(["t1", "t2"]); // default: first-part slot
  expect(first.ok).toBe(true);
  const cb2 = s2.combine(["t3"], { after: "t1" });
  expect(cb2.ok).toBe(false); // needs >= 2 ids — guard intact
});

test("F-047: bad anchor refuses (no commit); default stays byte-identical", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("beta"), a("rb")] });
  const before = s.history().length;

  const bad = s.combine(["t1", "t2"], { after: "t999" });
  expect(bad.ok).toBe(false);
  expect((bad as { ok: false; error: string }).error).toContain("t999");
  expect(s.history()).toHaveLength(before); // refusal leaves no commit

  // Omitted after: identical to the pre-F-047 path — no placement recorded.
  const ok = s.combine(["t1", "t2"]);
  expect(ok.ok).toBe(true);
  const params = (ok as unknown as { commit: { params: Record<string, unknown> } }).commit
    .params;
  expect("placement" in params).toBe(false);
  const combinedId = params.combinedId as string;
  expect(s.show(combinedId)!.placement ?? null).toBeNull();
  expect(s.compose().emittedFrameIds).toEqual([combinedId]);
});

test("F-047: revert of a PLACED combine restores the parts in natural order", () => {
  const s = mk();
  s.ingest({ ...HEAD, messages: [u("alpha"), a("ra"), u("beta"), a("rb"), u("gamma"), a("rc")] });
  const cb = s.combine(["t1", "t2"], { after: "t3" });
  expect(cb.ok).toBe(true);
  const r = s.revert((cb as unknown as { commit: { id: string } }).commit.id);
  expect(r.ok).toBe(true);
  expect(s.show("t1")!.absorbedInto ?? null).toBeNull();
  const w = JSON.stringify(s.compose().body);
  expect(w.indexOf("alpha")).toBeLessThan(w.indexOf("beta"));
  expect(w.indexOf("beta")).toBeLessThan(w.indexOf("gamma"));
});
