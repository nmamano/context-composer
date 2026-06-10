// §11 Phase 2.7 acceptance — FORK ISOLATION (per-request-view compose): requests that
// fork a conversation (suggestion/recap side queries that resend the full history plus
// an ephemeral instruction, colliding on the conversation key) must not write into the
// emitted linear context or ride along on later wire bodies. Fork frames stay in the
// store — visible, deletable — they are just absent from emissions whose request
// didn't carry them. "Scope emission, not matching": reconcile still matches against
// the full store including tombstones, so delete-then-unaware-resend is unchanged.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameStore } from "../src/engine/state.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-fork-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MAIN_HEAD = {
  model: "m",
  max_tokens: 64,
  system: "MAIN SYSTEM PROMPT",
  tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
};

/** POST an owned request through the proxy, drain it, then settle the async capture
 *  (a control read awaits lastCapture). */
function sender(base: string) {
  return async (body: unknown) => {
    await (
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).text();
    await fetch(`${base}/control/list`);
  };
}

function readTap(path: string): Array<Record<string, any>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

// ── Acceptance 1: main → suggestion(full history + extra instruction) → main ──
// The suggestion's frames are STORED but ABSENT from the later main outbound body.
// Also pins the surfacing: inLastView annotations, conversations forkFrames, and the
// wiretap's viewFrameIds/omittedFrameIds diff.
test("suggestion-mode fork: frames stored but absent from the next main emission", async () => {
  const stub: StubUpstream = startStubUpstream();
  const tapPath = join(dir, "tap.jsonl");
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, wiretapPath: tapPath });
    const base = `http://localhost:${proxy.port}`;
    const send = sender(base);

    // Main turn 1.
    stub.enqueue({ text: "main reply 1", stopReason: "end_turn" });
    await send({ ...MAIN_HEAD, messages: [{ role: "user", content: "hello main" }] });

    // Suggestion-mode side query: SAME opening message (the documented key collision,
    // observed live 2026-06-10) — full history + an ephemeral instruction frame.
    stub.enqueue({ text: "suggested follow-up prompts", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "main reply 1" },
        { role: "user", content: "EPHEMERAL INSTRUCTION: suggest follow-ups" },
      ],
    });

    // Main turn 2: the unaware main agent resends ITS OWN view (no suggestion frames).
    stub.enqueue({ text: "main reply 2", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "main reply 1" },
        { role: "user", content: "second main message" },
      ],
    });

    // One conversation (collided key) holding ALL frames — fork frames stay stored.
    const convs = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    expect(convs.conversations).toHaveLength(1);
    const list = (await (await fetch(`${base}/control/list`)).json()) as any;
    const turns = list.frames.filter((f: any) => f.kind === "turn");
    expect(turns).toHaveLength(3); // t1 main, t2 suggestion instruction, t3 second main

    // …but the main turn 2 OUTBOUND carries only the main thread: no suggestion
    // instruction, no captured suggestion reply.
    const mainWire = JSON.stringify(stub.received[2]);
    expect(mainWire).toContain("hello main");
    expect(mainWire).toContain("second main message");
    expect(mainWire).not.toContain("EPHEMERAL INSTRUCTION");
    expect(mainWire).not.toContain("suggested follow-up prompts");

    // Surfacing — list annotates the fork-only frame against the LAST emitted view.
    const byId = Object.fromEntries(list.frames.map((f: any) => [f.id, f]));
    expect(byId.p0.inLastView).toBeNull(); // preamble: never view membership
    expect(byId.t1.inLastView).toBe(true);
    expect(byId.t2.inLastView).toBe(false); // fork-only — explicable before deleting
    expect(byId.t3.inLastView).toBe(true);
    expect(convs.conversations[0].forkFrames).toBe(1);

    // Wiretap: the fork-isolation diff is visible per request. Main turn 2's entry
    // emitted [t1, t3] and reports the unmatched stored frame t2 as omitted.
    const tap = readTap(tapPath).filter((e) => e.kind === "messages");
    expect(tap).toHaveLength(3);
    expect(tap[2]!.viewFrameIds).toEqual(["t1", "t3"]);
    expect(tap[2]!.omittedFrameIds).toEqual(["t2"]);
    // The suggestion request's own view INCLUDED the matched main frame (matching is
    // unscoped — only emission is) plus its appended instruction frame.
    expect(tap[1]!.viewFrameIds).toEqual(["t1", "t2"]);
    expect(tap[1]!.omittedFrameIds).toEqual([]);
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

// ── Acceptance 2: deleted content resent later — tombstone matched IN the view,
// omitted from the outbound. Pins the delete-then-unaware-resend invariant under
// view-scoped compose, and the omittedFrameIds naming: in-view tombstones are
// omitted from `messages` but are NOT "omitted-unmatched" store frames.
test("deleted frame resent by the unaware agent: in the view, off the wire", async () => {
  const stub: StubUpstream = startStubUpstream();
  const tapPath = join(dir, "tap.jsonl");
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, wiretapPath: tapPath });
    const base = `http://localhost:${proxy.port}`;
    const send = sender(base);

    stub.enqueue({ text: "stored", stopReason: "end_turn" });
    await send({ ...MAIN_HEAD, messages: [{ role: "user", content: "the launch code is ZEPHYR-9" }] });

    // User deletes the secret frame through our surface; the agent doesn't know.
    const del = (await (
      await fetch(`${base}/control/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: ["t1"] }),
      })
    ).json()) as any;
    expect(del.deleted).toEqual(["t1"]);

    // The unaware resend carries the deleted content back.
    stub.enqueue({ text: "no code in context", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "the launch code is ZEPHYR-9" },
        { role: "assistant", content: "stored" },
        { role: "user", content: "repeat the launch code" },
      ],
    });

    const wire = JSON.stringify(stub.received[1]);
    expect(wire).not.toContain("ZEPHYR-9"); // tombstone wins
    expect(wire).toContain("repeat the launch code");
    expect((stub.received[1] as any).messages).toHaveLength(1); // only the live frame

    const tap = readTap(tapPath).filter((e) => e.kind === "messages");
    // The tombstone WAS matched into the view (scope emission, not matching)…
    expect(tap[1]!.viewFrameIds).toEqual(["t1", "t2"]);
    // …and therefore does NOT appear among the omitted-unmatched store frames, even
    // though its content is omitted from the outbound `messages`.
    expect(tap[1]!.omittedFrameIds).toEqual([]);
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

// ── Acceptance 3 (the live t7-leak regression, 2026-06-10): a fork capture that
// SUMMARIZES DELETED CONTENT stays on the fork view — it never rides the next main
// compose, and neither does the tombstoned secret it summarized.
test("a fork capture containing deleted content never rides the next main emission", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
    const base = `http://localhost:${proxy.port}`;
    const send = sender(base);

    stub.enqueue({ text: "noted", stopReason: "end_turn" });
    await send({ ...MAIN_HEAD, messages: [{ role: "user", content: "the secret is ZEPHYR-7" }] });

    stub.enqueue({ text: "done working", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "the secret is ZEPHYR-7" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "now do some work" },
      ],
    });

    // Delete the secret frame (t1).
    await fetch(`${base}/control/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["t1"] }),
    });

    // Suggestion fork resends the FULL history (secret included — the agent is
    // unaware) + an instruction; the model's reply summarizes the deleted secret.
    // It must be captured onto the FORK's open frame (the view's openFrameId — the
    // instruction frame t3), not the main thread's tail.
    stub.enqueue({ text: "Earlier the secret ZEPHYR-7 was mentioned; rotate it", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "the secret is ZEPHYR-7" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "now do some work" },
        { role: "assistant", content: "done working" },
        { role: "user", content: "EPHEMERAL: suggest what to do next" },
      ],
    });

    // Next main turn: its emission must contain neither the tombstoned secret nor
    // the fork's captured summary of it.
    stub.enqueue({ text: "final answer", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "the secret is ZEPHYR-7" },
        { role: "assistant", content: "noted" },
        { role: "user", content: "now do some work" },
        { role: "assistant", content: "done working" },
        { role: "user", content: "final question" },
      ],
    });

    const wire = JSON.stringify(stub.received[3]);
    expect(wire).not.toContain("ZEPHYR-7"); // neither the tombstone…
    expect(wire).not.toContain("rotate it"); // …nor the fork capture that summarized it
    expect(wire).not.toContain("EPHEMERAL");
    expect(wire).toContain("now do some work");
    expect(wire).toContain("final question");

    // The leak evidence is still IN THE STORE (visible, deletable) — on the fork frame.
    const show = (await (await fetch(`${base}/control/show?id=t3`)).json()) as any;
    expect(JSON.stringify(show.messages)).toContain("rotate it");
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

// ── Capture targeting mechanics (the adjacent edge to acceptance 4, store-level):
// a request whose frames are a strict PREFIX of the store view gets its reply
// attached to ITS view's open frame — not the store tail — and the main thread's
// authoritative resend refreshes the frame, purging the foreign reply (self-heal).
// (The full head-only-side-instruction variant is deliberately NOT pre-engineered;
// it gets a test only if observed live — design.md §11 Phase 2.7.)
test("capture targets the view's open frame, not the store tail; main resend self-heals", () => {
  const store = new FrameStore(null);
  const HEAD = { model: "m", max_tokens: 10, system: "SYS" };
  const u1 = { role: "user", content: "turn one" };
  const a1 = { role: "assistant", content: "reply one" };
  const u2 = { role: "user", content: "turn two" };
  const a2 = { role: "assistant", content: "reply two" };
  const reply = (text: string) => ({
    message: { role: "assistant" as const, content: [{ type: "text", text }] },
    stopReason: "end_turn",
  });

  const v1 = store.ingest({ ...HEAD, messages: [u1] });
  expect(v1).toMatchObject({ frameIds: ["t1"], openFrameId: "t1", createdIds: ["t1"] });
  store.captureAssistant(reply("reply one"), v1.openFrameId);

  const v2 = store.ingest({ ...HEAD, messages: [u1, a1, u2] });
  expect(v2.frameIds).toEqual(["t1", "t2"]);
  store.captureAssistant(reply("reply two"), v2.openFrameId);

  // Fork request carrying only a PREFIX of the history: its view ends at t1, while
  // the store tail is t2 — the explicit target diverges from store.openFrameId().
  const vFork = store.ingest({ ...HEAD, messages: [u1, a1] });
  expect(vFork.frameIds).toEqual(["t1"]);
  expect(vFork.openFrameId).toBe("t1");
  expect(store.openFrameId()).toBe("t2");
  store.captureAssistant(reply("FORK NOISE"), vFork.openFrameId);

  // Accepted edge: the fork reply temporarily sits on the main frame it continued…
  expect(JSON.stringify(store.show("t1")!.messages)).toContain("FORK NOISE");

  // …until the main thread's next authoritative resend refreshes the frame.
  const v3 = store.ingest({ ...HEAD, messages: [u1, a1, u2, a2, { role: "user", content: "turn three" }] });
  expect(v3.frameIds).toEqual(["t1", "t2", "t3"]);
  const wire = JSON.stringify(store.compose(v3).body);
  expect(wire).not.toContain("FORK NOISE"); // purged by the refresh — self-healed
  expect(wire).toContain("turn three");
});

// ── /control/compose semantics: full-store default + viewNote; ?view=last is the
// view-scoped CURRENT representation (not a byte snapshot of the prior outbound —
// the settled capture is reflected); derived only, so it is absent after a restart.
test("/control/compose: default full-store + viewNote; ?view=last view-scoped; gone after restart", async () => {
  const stub: StubUpstream = startStubUpstream();
  const storePath = join(dir, "registry.json");
  const port = 8797;
  const base = `http://localhost:${port}`;
  let proxy: ProxyHandle | undefined;
  const boot = () => (proxy = startProxy({ port, upstreamBaseUrl: stub.baseUrl, storePath }));
  try {
    boot();
    const send = sender(base);

    stub.enqueue({ text: "main reply 1", stopReason: "end_turn" });
    await send({ ...MAIN_HEAD, messages: [{ role: "user", content: "hello main" }] });
    // A fork rides in so the full-store and view-scoped composes genuinely differ.
    stub.enqueue({ text: "fork reply", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "main reply 1" },
        { role: "user", content: "EPHEMERAL fork instruction" },
      ],
    });
    stub.enqueue({ text: "main reply 2", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "main reply 1" },
        { role: "user", content: "second main message" },
      ],
    });

    // Default: full-store (fork frame present) + the viewNote disclaimer.
    const full = (await (await fetch(`${base}/control/compose?dump`)).json()) as any;
    expect(full.viewNote).toContain("full-store");
    expect(full.viewFrameIds).toBeUndefined();
    expect(JSON.stringify(full.body)).toContain("EPHEMERAL fork instruction");

    // ?view=last: scoped to the last emitted view (main turn 2 — no fork frame), and
    // composed from the CURRENT store representation: the capture that settled AFTER
    // the outbound was sent ("main reply 2") is reflected, so this is explicitly NOT
    // a byte snapshot of the prior outbound request.
    const last = (await (await fetch(`${base}/control/compose?view=last&dump`)).json()) as any;
    expect(last.view).toBe("last");
    expect(last.viewFrameIds).toEqual(["t1", "t3"]);
    expect(last.viewNote).toBeUndefined();
    const lastWire = JSON.stringify(last.body);
    expect(lastWire).not.toContain("EPHEMERAL fork instruction");
    expect(lastWire).toContain("second main message");
    expect(lastWire).toContain("main reply 2"); // current representation, post-capture

    // Unknown view value: explicit 400, not silent full-store.
    expect((await fetch(`${base}/control/compose?view=bogus`)).status).toBe(400);

    // Restart on the same durable store: frames survive, the VIEW does not (derived
    // per request, never persisted) — and list annotations reset to null.
    proxy!.stop();
    boot();
    expect((await fetch(`${base}/control/compose?view=last`)).status).toBe(404);
    const list = (await (await fetch(`${base}/control/list`)).json()) as any;
    for (const f of list.frames) expect(f.inLastView).toBeNull();
    const convs = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    expect(convs.conversations[0].forkFrames).toBe(0); // not applicable without a view
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

// ── F-045 (Phase 5e, Nil-authorized 2026-06-10): suggestion-mode frames are ──
// marked fork-only EARLY — a captured turn frame whose first message's first
// text content starts (after trim) with the literal `*[SUGGESTION MODE` is
// annotated inLastView=false even while the last emitted view still carries
// it. Derived annotation only: store-level, no proxy needed. This is the
// engine's single authorized content heuristic — these tests pin its exact
// scope so it cannot silently widen.

const F045_HEAD = {
  system: "SYS",
  tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
};

test("F-045: marker frame is fork-only IMMEDIATELY (before the next main request reveals it)", () => {
  const store = new FrameStore();
  const v1 = store.ingest({ ...F045_HEAD, messages: [{ role: "user", content: "hello main" }] });
  store.noteEmittedView(v1);
  // The suggestion side query: full history resent + the marker'd instruction.
  // Its OWN request view includes the new frame — pre-F-045 that meant
  // inLastView=true until the next main-thread request dropped it.
  const v2 = store.ingest({
    ...F045_HEAD,
    messages: [
      { role: "user", content: "hello main" },
      { role: "assistant", content: "main reply 1" },
      { role: "user", content: "*[SUGGESTION MODE: suggest follow-ups]* please" },
    ],
  });
  store.noteEmittedView(v2);
  const byId = Object.fromEntries(store.list().map((f) => [f.id, f]));
  expect(byId.t2!.inLastView).toBe(false); // the exception fires
  expect(byId.t1!.inLastView).toBe(true); // main frame untouched
  expect(byId.p0!.inLastView).toBeNull(); // preamble: never applicable
});

test("F-045: control — same shape WITHOUT the marker keeps today's behavior (true until revealed)", () => {
  const store = new FrameStore();
  const v1 = store.ingest({ ...F045_HEAD, messages: [{ role: "user", content: "hello main" }] });
  store.noteEmittedView(v1);
  const v2 = store.ingest({
    ...F045_HEAD,
    messages: [
      { role: "user", content: "hello main" },
      { role: "assistant", content: "main reply 1" },
      { role: "user", content: "EPHEMERAL INSTRUCTION: suggest follow-ups" },
    ],
  });
  store.noteEmittedView(v2);
  const byId = Object.fromEntries(store.list().map((f) => [f.id, f]));
  expect(byId.t2!.inLastView).toBe(true); // no marker → no exception
});

test("F-045: ANY currently-true marker frame flips, not just the latest (reviewer condition)", () => {
  const store = new FrameStore();
  const v = store.ingest({
    ...F045_HEAD,
    messages: [
      { role: "user", content: "hello main" },
      { role: "assistant", content: "main reply 1" },
      { role: "user", content: "*[SUGGESTION MODE: A]* one" },
      { role: "assistant", content: "suggestions A" },
      { role: "user", content: "*[SUGGESTION MODE: B]* two" },
    ],
  });
  store.noteEmittedView(v);
  const byId = Object.fromEntries(store.list().map((f) => [f.id, f]));
  expect(byId.t1!.inLastView).toBe(true);
  expect(byId.t2!.inLastView).toBe(false); // earlier marker frame NOT stranded
  expect(byId.t3!.inLastView).toBe(false);
});

test("F-045: exact scope — block content + leading whitespace match; mid-text does NOT", () => {
  const store = new FrameStore();
  const v = store.ingest({
    ...F045_HEAD,
    messages: [
      { role: "user", content: [{ type: "text", text: "  *[SUGGESTION MODE: blocks]* hi" }] },
      { role: "assistant", content: "r1" },
      { role: "user", content: "quoting *[SUGGESTION MODE in the middle is fine" },
    ],
  });
  store.noteEmittedView(v);
  const byId = Object.fromEntries(store.list().map((f) => [f.id, f]));
  expect(byId.t1!.inLastView).toBe(false); // array-of-blocks form + trim
  expect(byId.t2!.inLastView).toBe(true); // prefix only — mid-text never fires
});

test("F-045: annotation-only — compose/view membership is byte-identical with and without the marker", () => {
  const store = new FrameStore();
  const v1 = store.ingest({ ...F045_HEAD, messages: [{ role: "user", content: "hello main" }] });
  store.noteEmittedView(v1);
  const v2 = store.ingest({
    ...F045_HEAD,
    messages: [
      { role: "user", content: "hello main" },
      { role: "assistant", content: "main reply 1" },
      { role: "user", content: "*[SUGGESTION MODE: X]* go" },
    ],
  });
  // The marker frame still composes exactly per ITS request's view — the
  // annotation never touches membership or emission.
  expect(v2.frameIds).toContain("t2");
  const composed = store.compose(v2);
  expect(composed.emittedFrameIds).toContain("t2");
  expect(JSON.stringify(composed.body)).toContain("SUGGESTION MODE: X");
});
