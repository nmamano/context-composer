// §11 Phase 2.6 acceptance — CONVERSATION IDENTITY: a real interactive agent multiplexes
// independent conversations over POST /v1/messages (main thread + title/recap/quota
// side queries). The registry must keep them separate: no side-query content in the
// main thread's wire body, no main-thread content in a side query's, no head
// clobbering — and identity must survive the agent re-encoding the same message
// between string and text-block forms (the wedged-store t4/t5 duplication).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationKey, ConversationRegistry } from "../src/engine/registry.ts";
import { FrameStore } from "../src/engine/state.ts";
import { fingerprintHead, fingerprintMessage } from "../src/engine/fingerprint.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-conv-"));
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

// ── identity: derived key, encoding-insensitive ───────────────────────────────

test("fingerprintMessage: string content ≡ single text block (identity only)", () => {
  const asString = fingerprintMessage({ role: "user", content: "read the file" });
  const asArray = fingerprintMessage({
    role: "user",
    content: [{ type: "text", text: "read the file" }],
  });
  expect(asString).toBe(asArray);
  expect(fingerprintMessage({ role: "user", content: "other" })).not.toBe(asString);
});

test("fingerprintHead: string system ≡ single text block; cache_control stripped", () => {
  const a = fingerprintHead("SYS", undefined);
  const b = fingerprintHead([{ type: "text", text: "SYS" }], undefined);
  const c = fingerprintHead(
    [{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }],
    undefined,
  );
  expect(a).toBe(b);
  expect(b).toBe(c);
  expect(fingerprintHead("OTHER", undefined)).not.toBe(a);
});

test("conversationKey follows the opening turn — stable across re-encodings AND volatile heads", () => {
  const a = conversationKey({ ...MAIN_HEAD, messages: [{ role: "user", content: "hello" }] });
  const b = conversationKey({
    ...MAIN_HEAD,
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] }, // re-encoded
      { role: "assistant", content: "hi" }, // grown history — key anchors on the FIRST frame
    ],
  });
  expect(a).toBe(b);

  // The head is deliberately NOT part of identity: the agent embeds a per-invocation
  // billing hash in a system block (live wiretap evidence: `cch=` changes on every
  // process start), so a resume/restart re-keys the head. Same opening turn → same
  // conversation, even with a different head.
  const resumed = conversationKey({
    ...MAIN_HEAD,
    system: "MAIN SYSTEM PROMPT (volatile billing hash cch=87276)",
    messages: [{ role: "user", content: "hello" }],
  });
  expect(resumed).toBe(a);

  // A different opening turn is a different conversation (side queries).
  const side = conversationKey({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "quota" }] });
  expect(side).not.toBe(a);
});

// The wedged-store t4/t5 regression, at the store level: the agent resends the same
// turn with the user message re-encoded string→array. One frame, ONE tool_use.
test("re-encoded resend does not fork the frame or duplicate its tool_use", () => {
  const store = new FrameStore(null);
  const asst = {
    role: "assistant" as const,
    content: [
      { type: "thinking", thinking: "", signature: "sigH" },
      { type: "tool_use", id: "tuDup", name: "Read", input: {} },
    ],
  };
  store.ingest({ ...MAIN_HEAD, messages: [{ role: "user", content: [{ type: "text", text: "Read the file README.md" }] }, asst] });
  store.ingest({
    ...MAIN_HEAD,
    messages: [
      { role: "user", content: "Read the file README.md" }, // SAME message, string form
      asst,
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tuDup", content: "line" }] },
    ],
  });
  expect(store.list().filter((f) => f.kind === "turn")).toHaveLength(1);
  const wire = JSON.stringify(store.compose().body);
  expect(wire.split('"tuDup"').length - 1).toBe(2); // one tool_use + its tool_result
});

// ── the registry through the real proxy: no cross-conversation bleed ──────────

test("side queries get their own conversation: no bleed either direction, no head clobbering", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
    const base = `http://localhost:${proxy.port}`;
    const send = async (body: unknown) => {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await res.text(); // drain
      await fetch(`${base}/control/list`); // settle the async capture
    };

    // Main turn 1, then a side query, then main turn 2 (the TUI interleaving).
    stub.enqueue({ text: "main reply 1", stopReason: "end_turn" });
    await send({ ...MAIN_HEAD, messages: [{ role: "user", content: "hello main" }] });

    stub.enqueue({ text: "side reply", stopReason: "end_turn" });
    await send({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "quota" }] });

    // Early-session edge: at 1 turn-frame each, the NEWER side query must not steal
    // `active` — the token-estimate tiebreak keeps the real session (big head) active.
    const early = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    const earlyActive = early.conversations.find((c: any) => c.active);
    expect(earlyActive.tokenEstimate).toBeGreaterThan(
      Math.max(...early.conversations.filter((c: any) => !c.active).map((c: any) => c.tokenEstimate)),
    );

    stub.enqueue({ text: "main reply 2", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "main reply 1" },
        { role: "user", content: "second main message" },
      ],
    });

    // The side query's forwarded body: ONLY its own content — no main system, no main messages.
    const sideWire = JSON.stringify(stub.received[1]);
    expect((stub.received[1] as any).messages).toEqual([{ role: "user", content: "quota" }]);
    expect(sideWire).not.toContain("MAIN SYSTEM PROMPT");
    expect(sideWire).not.toContain("hello main");

    // Main turn 2's forwarded body: full main thread, head intact, NO side-query content.
    const mainWire = JSON.stringify(stub.received[2]);
    expect(mainWire).toContain("hello main");
    expect(mainWire).toContain("second main message");
    expect(mainWire).toContain("MAIN SYSTEM PROMPT"); // head not clobbered by the side query
    expect(mainWire).not.toContain("quota");

    // Control surface: two conversations; the main thread is active (more turn frames).
    const convs = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    expect(convs.conversations).toHaveLength(2);
    const active = convs.conversations.find((c: any) => c.active);
    expect(active.turnFrames).toBe(2);
    const side = convs.conversations.find((c: any) => !c.active);
    expect(side.turnFrames).toBe(1);

    // ?conv= targets the side conversation explicitly.
    const sideList = (await (await fetch(`${base}/control/list?conv=${side.id}`)).json()) as any;
    expect(sideList.conv).toBe(side.id);
    expect(sideList.frames.some((f: any) => f.kind === "turn")).toBe(true);

    // Default list targets the active (main) conversation.
    const mainList = (await (await fetch(`${base}/control/list`)).json()) as any;
    expect(mainList.conv).toBe(active.id);
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

test("the registry survives a restart: conversations, active selection, composed wire", async () => {
  const stub: StubUpstream = startStubUpstream();
  const storePath = join(dir, "registry.json");
  const port = 8796;
  let proxy: ProxyHandle | undefined;
  const boot = () => (proxy = startProxy({ port, upstreamBaseUrl: stub.baseUrl, storePath }));
  const base = `http://localhost:${port}`;
  try {
    boot();
    const send = async (body: unknown) => {
      await (await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })).text();
      await fetch(`${base}/control/list`);
    };
    stub.enqueue({ text: "r1", stopReason: "end_turn" });
    await send({ ...MAIN_HEAD, messages: [{ role: "user", content: "hello main" }] });
    stub.enqueue({ text: "s1", stopReason: "end_turn" });
    await send({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "quota" }] });
    proxy!.stop();

    boot(); // restart on the same registry file
    const convs = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    expect(convs.conversations).toHaveLength(2);
    // Identity survives: resending the main thread matches the restored conversation.
    stub.enqueue({ text: "r2", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: [{ type: "text", text: "hello main" }] }, // re-encoded, still matches
        { role: "assistant", content: "r1" },
        { role: "user", content: "after restart" },
      ],
    });
    const convs2 = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    expect(convs2.conversations).toHaveLength(2); // no third conversation forked
    const wire = JSON.stringify(stub.received[stub.received.length - 1]);
    expect(wire).toContain("after restart");
    expect(wire).not.toContain("quota");
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

// Reviewer P1 regression: deletion is curation, not abandonment. Deleting every live
// turn frame of the curated conversation must NOT demote it — the next DEFAULT
// control op (the user's `ctx revert`!) still targets it.
test("deleting all live turn frames does not demote the active conversation; default revert works", async () => {
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

    // Main: 2 turns. Side query: 1 turn (more recent).
    stub.enqueue({ text: "r1", stopReason: "end_turn" });
    await send({ ...MAIN_HEAD, messages: [{ role: "user", content: "hello main" }] });
    stub.enqueue({ text: "r2", stopReason: "end_turn" });
    await send({
      ...MAIN_HEAD,
      messages: [
        { role: "user", content: "hello main" },
        { role: "assistant", content: "r1" },
        { role: "user", content: "second" },
      ],
    });
    stub.enqueue({ text: "s", stopReason: "end_turn" });
    await send({ model: "m", max_tokens: 8, messages: [{ role: "user", content: "quota" }] });

    // Delete BOTH live main turn frames via the DEFAULT (active) route.
    const mainList = (await (await fetch(`${base}/control/list`)).json()) as any;
    const mainConv = mainList.conv;
    const turnIds = mainList.frames.filter((f: any) => f.kind === "turn").map((f: any) => f.id);
    expect(turnIds).toHaveLength(2);
    const del = (await (await fetch(`${base}/control/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: turnIds }),
    })).json()) as any;
    expect(del.conv).toBe(mainConv);
    expect(del.deleted).toEqual(turnIds);

    // Main now has 0 live turn frames — but stays ACTIVE (total includes tombstones).
    const convs = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    const active = convs.conversations.find((c: any) => c.active);
    expect(active.id).toBe(mainConv);
    expect(active.turnFrames).toBe(0);
    expect(active.totalTurnFrames).toBe(2);

    // The user's natural next step — default revert (HEAD) — hits the MAIN conversation.
    const rev = (await (await fetch(`${base}/control/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()) as any;
    expect(rev.conv).toBe(mainConv);
    expect(rev.reverted.type).toBe("revert");
    const after = (await (await fetch(`${base}/control/list`)).json()) as any;
    expect(after.conv).toBe(mainConv);
    expect(after.frames.filter((f: any) => f.kind === "turn" && !f.deleted)).toHaveLength(2);
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

// Identity tripwire: first contact carrying history is flagged structurally, not
// just on stderr — it must survive into /control/conversations (and persistence).
test("a new conversation born with history is flagged suspicious in summaries", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
    const base = `http://localhost:${proxy.port}`;
    stub.enqueue({ text: "ok", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...MAIN_HEAD,
        messages: [
          { role: "user", content: "we never saw turn one" },
          { role: "assistant", content: "but here is its reply" },
          { role: "user", content: "and a follow-up" },
        ],
      }),
    })).text();
    const convs = (await (await fetch(`${base}/control/conversations`)).json()) as any;
    expect(convs.conversations).toHaveLength(1);
    expect(convs.conversations[0].suspicious).toMatchObject({
      reason: "new-conversation-with-history",
      frameCount: 2,
    });
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

test("a registry file with a foreign version fails loudly", () => {
  const storePath = join(dir, "registry.json");
  Bun.write(storePath, JSON.stringify({ version: 99, convCounter: 0, ingestSeq: 0, conversations: [] }));
  expect(() => new ConversationRegistry(storePath)).toThrow(/version 99/);
});

// Pre-ingest control reads see an (empty) active store, and the first ingest ADOPTS
// that same store — the Phase ≤2.5 single-conversation surface is preserved.
test("eager default store is adopted by the first ingest (handle.store stays coherent)", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
    const before = proxy.store; // pre-ingest access → eager default
    expect(before.list()).toHaveLength(0);

    stub.enqueue({ text: "ok", stopReason: "end_turn" });
    await (await fetch(`http://localhost:${proxy.port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...MAIN_HEAD, messages: [{ role: "user", content: "hi" }] }),
    })).text();
    await fetch(`http://localhost:${proxy.port}/control/list`);

    expect(proxy.store).toBe(before); // same store object — adopted, not replaced
    expect(before.list().filter((f) => f.kind === "turn")).toHaveLength(1);
    expect(proxy.registry.summaries()).toHaveLength(1); // adopted, not duplicated
  } finally {
    proxy?.stop();
    stub.stop();
  }
});
