// Engine batch A (plans/ui-feedback.md F-001/F-017, plan-gated 2026-06-10) —
// ingest enrichment: async auto title+summary as METADATA FILL, audited via an
// `enriched` timeline event, never a commit. Reviewer-required coverage:
// strict parse + caps, fill-only-if-placeholder/null, manual-wins race,
// deleted/missing/ineligible skip, failure path = no mutation, queue
// serialization, explicit-gate env activation, offload default chain (engine)
// — all with stub clients: NO quota, NO network.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FrameStore } from "../src/engine/state.ts";
import { envEnrichClient, type LlmClient } from "../src/engine/llm.ts";
import {
  EnrichmentQueue,
  enrichPrompt,
  parseEnrichment,
  SUMMARY_MAX,
  TITLE_MAX,
} from "../src/proxy/enrich.ts";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
let framesDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-enrich-"));
  framesDir = join(dir, "frames");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const HEAD = { model: "m", max_tokens: 64, system: "SYS" };
const u1 = { role: "user" as const, content: "how do I rotate the api keys safely?" };
const a1 = { role: "assistant" as const, content: "use the staged rotation runbook" };

function mkStore(): FrameStore {
  return new FrameStore(null, "test", framesDir);
}
function stubLlm(reply: string | (() => Promise<string>)): LlmClient {
  return {
    complete: typeof reply === "string" ? async () => reply : reply,
  };
}
const GOOD = '{"title": "API key rotation", "summary": "User asked how to rotate keys; assistant pointed at the staged runbook."}';

// ── parseEnrichment: untrusted output, strict validation ─────────────────────

test("parse: plain JSON object passes; values whitespace-collapsed", () => {
  // \\n: the JSON itself must escape control chars; the PARSED value carries a
  // real newline, which the collapser folds to one space.
  const r = parseEnrichment('{"title": "  API\\n key   rotation ", "summary": "a  b"}');
  expect(r).toEqual({ title: "API key rotation", summary: "a b" });
});

test("parse: fenced / prefixed output tolerated, object still strict", () => {
  expect(parseEnrichment("```json\n" + GOOD + "\n```")).not.toBeNull();
  expect(parseEnrichment("Here you go:\n" + GOOD)).not.toBeNull();
});

test("parse: malformed/empty/non-string values are rejected (no-op)", () => {
  expect(parseEnrichment("not json at all")).toBeNull();
  expect(parseEnrichment('{"title": "x"}')).toBeNull(); // missing summary
  expect(parseEnrichment('{"title": "", "summary": "y"}')).toBeNull();
  expect(parseEnrichment('{"title": "   ", "summary": "y"}')).toBeNull();
  expect(parseEnrichment('{"title": 4, "summary": "y"}')).toBeNull();
  expect(parseEnrichment('{"title": {"x": 1}, "summary": "y"}')).toBeNull();
  expect(parseEnrichment("")).toBeNull();
});

test("parse: hard length caps (summary rides the wire post-F-017)", () => {
  const long = "x".repeat(1000);
  const r = parseEnrichment(`{"title": "${long}", "summary": "${long}"}`)!;
  expect(r.title.length).toBeLessThanOrEqual(TITLE_MAX);
  expect(r.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
});

test("prompt: carries the turn content and demands bare JSON", () => {
  const p = enrichPrompt([u1, a1]);
  expect(p).toContain("rotate the api keys");
  expect(p).toContain('{"title": "...", "summary": "..."}');
});

test("prompt: head+tail truncation keeps the user's ask at the END of a huge message", () => {
  // Live-check regression: agent harnesses front-load multi-KB reminder
  // blocks; a head-only cut ate the real question.
  const huge = {
    role: "user" as const,
    content:
      "<system-reminder>" + "skill listing… ".repeat(700) + "</system-reminder>\n" +
      "THE-REAL-QUESTION-IS-HERE?",
  };
  const p = enrichPrompt([huge]);
  expect(p).toContain("THE-REAL-QUESTION-IS-HERE?");
  expect(p).toContain("(…middle truncated…)");
});

// ── FrameStore.enrich: metadata fill under LATEST-state checks ───────────────

test("enrich fills placeholder title + null summary; event audited, NO commit", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  const commitsBefore = s.history().length;

  const r = s.enrich("t1", { title: "Key rotation", summary: "S.", source: "stub:m@low" });
  expect(r).toEqual({ ok: true, applied: ["title", "summary"] });
  expect(s.show("t1")!.title).toBe("Key rotation");
  expect(s.show("t1")!.summary).toBe("S.");
  // Audited, not silent: an `enriched` event with fields + provider label…
  const ev = s.timeline().filter((e) => e.type === "enriched");
  expect(ev).toHaveLength(1);
  expect(ev[0]!.frameIds).toEqual(["t1"]);
  expect(ev[0]!.commitId).toBeNull();
  expect(ev[0]!.note).toBe("title+summary via stub:m@low");
  // …and NEVER a commit (no history flooding; revert semantics untouched).
  expect(s.history().length).toBe(commitsBefore);
});

test("manual retitle WINS per field: title skipped, summary still fills", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.retitle("t1", { title: "my own title" });

  const r = s.enrich("t1", { title: "auto title", summary: "auto summary" });
  expect(r).toEqual({ ok: true, applied: ["summary"] });
  expect(s.show("t1")!.title).toBe("my own title"); // untouched
  expect(s.show("t1")!.summary).toBe("auto summary");
});

test("nothing left to fill → ok, applied [], and NO event", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.retitle("t1", { title: "t", summary: "s" });
  const r = s.enrich("t1", { title: "auto", summary: "auto" });
  expect(r).toEqual({ ok: true, applied: [] });
  expect(s.timeline().filter((e) => e.type === "enriched")).toHaveLength(0);
});

test("deleted / missing / non-turn frames refuse", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.delete(["t1"]);
  expect(s.enrich("t1", { title: "x" }).ok).toBe(false);
  expect(s.enrich("t99", { title: "x" }).ok).toBe(false);
  const preamble = s.list().find((f) => f.kind === "preamble");
  if (preamble) expect(s.enrich(preamble.id, { title: "x" }).ok).toBe(false);
});

// ── F-017: offload default chain prefers the frame's own summary ─────────────

test("offload stub: opts.summary ?? f.summary ?? deriveSummary ?? fallback", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  // (1) f.summary (enrichment) beats deriveSummary's first-line echo.
  s.enrich("t1", { summary: "User asked about key rotation." });
  s.offload("t1");
  let stub = JSON.stringify(s.show("t1")!.representation);
  expect(stub).toContain("User asked about key rotation.");
  expect(stub).not.toContain("how do I rotate the api keys safely?");
  s.restore("t1");
  // (2) explicit opts.summary beats f.summary.
  s.offload("t1", { summary: "explicit override" });
  stub = JSON.stringify(s.show("t1")!.representation);
  expect(stub).toContain("explicit override");
});

test("offload without f.summary still derives the first line (pre-A behavior)", () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.offload("t1");
  expect(JSON.stringify(s.show("t1")!.representation)).toContain(
    "how do I rotate the api keys safely?",
  );
});

// ── EnrichmentQueue: serialization, races, failure paths ─────────────────────

test("queue: applies parsed metadata via store.enrich with the provider label", async () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  const q = new EnrichmentQueue(stubLlm(GOOD), "stub:sonnet@low", () => {});
  await q.enqueue(s, "c1", "t1");
  expect(s.show("t1")!.title).toBe("API key rotation");
  expect(s.timeline().find((e) => e.type === "enriched")!.note).toContain(
    "via stub:sonnet@low",
  );
});

test("queue: STRICTLY one in flight — second call waits for the first", async () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.ingest({ ...HEAD, messages: [u1, a1, { role: "user", content: "next q" }] });
  let inFlight = 0;
  let maxInFlight = 0;
  const q = new EnrichmentQueue(
    stubLlm(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return GOOD;
    }),
    "stub",
    () => {},
  );
  const p1 = q.enqueue(s, "c1", "t1");
  const p2 = q.enqueue(s, "c1", "t2");
  await Promise.all([p1, p2]);
  expect(maxInFlight).toBe(1);
  expect(s.show("t1")!.title).toBe("API key rotation");
  expect(s.show("t2")!.title).toBe("API key rotation");
});

test("queue: manual retitle DURING the LLM call wins the race (apply-time check)", async () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const q = new EnrichmentQueue(
    stubLlm(async () => {
      await gate;
      return GOOD;
    }),
    "stub",
    () => {},
  );
  const p = q.enqueue(s, "c1", "t1");
  s.retitle("t1", { title: "user title mid-flight" });
  release();
  await p;
  expect(s.show("t1")!.title).toBe("user title mid-flight"); // manual wins
  expect(s.show("t1")!.summary).toBe(
    "User asked how to rotate keys; assistant pointed at the staged runbook.",
  ); // summary was still open — filled
});

test("queue: LLM failure and malformed output are non-fatal no-ops", async () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  const logs: string[] = [];
  const qFail = new EnrichmentQueue(
    stubLlm(async () => {
      throw new Error("boom");
    }),
    "stub",
    (m) => logs.push(m),
  );
  await qFail.enqueue(s, "c1", "t1");
  const qBad = new EnrichmentQueue(stubLlm("no json here"), "stub", (m) => logs.push(m));
  await qBad.enqueue(s, "c1", "t1");
  expect(s.show("t1")!.title).toBe("frame t1"); // placeholder intact
  expect(s.show("t1")!.summary ?? null).toBeNull();
  expect(s.timeline().filter((e) => e.type === "enriched")).toHaveLength(0);
  expect(logs.length).toBe(2);
  for (const l of logs) expect(l).not.toContain("rotate the api keys"); // never the prompt
});

test("queue: fully-titled frame skips the LLM call entirely", async () => {
  const s = mkStore();
  s.ingest({ ...HEAD, messages: [u1, a1] });
  s.retitle("t1", { title: "t", summary: "s" });
  let calls = 0;
  const q = new EnrichmentQueue(
    stubLlm(async () => {
      calls++;
      return GOOD;
    }),
    "stub",
    () => {},
  );
  await q.enqueue(s, "c1", "t1");
  expect(calls).toBe(0);
});

// ── envEnrichClient: the explicit gate (reviewer condition #2) ───────────────

const ENV_KEYS = [
  "CC_ENRICH_ON_INGEST", "CC_ENRICH_MODEL", "CC_ENRICH_EFFORT",
  "CC_LLM_API_KEY", "CC_LLM_MODEL", "CC_LLM_BASE_URL",
  "CC_LLM_CLAUDE_CLI", "CC_CLAUDE_BIN", "CC_LLM_CLI_TIMEOUT_MS",
];

function withEnv(env: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("gate: provider alone NEVER activates enrichment (no silent per-turn burn)", () => {
  withEnv({ CC_LLM_CLAUDE_CLI: "1" }, () => {
    expect(envEnrichClient()).toBeNull();
  });
  withEnv({ CC_LLM_API_KEY: "k", CC_LLM_MODEL: "m" }, () => {
    expect(envEnrichClient()).toBeNull();
  });
});

test("gate: CC_ENRICH_ON_INGEST=1 without any provider is still null", () => {
  withEnv({ CC_ENRICH_ON_INGEST: "1" }, () => {
    expect(envEnrichClient()).toBeNull();
  });
});

test("gate: gate + CLI provider → sonnet@low by default; model/effort overridable", () => {
  withEnv({ CC_ENRICH_ON_INGEST: "1", CC_LLM_CLAUDE_CLI: "1" }, () => {
    expect(envEnrichClient()!.label).toBe("claude-cli:claude-sonnet-4-6@low");
  });
  withEnv(
    {
      CC_ENRICH_ON_INGEST: "1", CC_LLM_CLAUDE_CLI: "1",
      CC_ENRICH_MODEL: "claude-haiku-4-5", CC_ENRICH_EFFORT: "medium",
    },
    () => {
      expect(envEnrichClient()!.label).toBe("claude-cli:claude-haiku-4-5@medium");
    },
  );
});

test("gate: gate + API key → api client with the enrich model (regen env untouched)", () => {
  withEnv({ CC_ENRICH_ON_INGEST: "1", CC_LLM_API_KEY: "k" }, () => {
    expect(envEnrichClient()!.label).toBe("api:claude-sonnet-4-6");
  });
});

// ── end-to-end through the proxy: capture → async enrich → timeline ──────────

test("proxy: a captured turn gets enriched asynchronously; timeline audits it", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | null = null;
  try {
    proxy = startProxy({
      port: 0,
      upstreamBaseUrl: stub.baseUrl,
      framesDir,
      enrich: { client: stubLlm(GOOD), label: "stub:sonnet@low" },
    });
    const base = `http://localhost:${proxy.port}`;
    await (
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...HEAD, messages: [u1] }),
      })
    ).text();
    // Enrichment is fire-and-forget AFTER the capture settles — poll briefly.
    let enriched: unknown[] = [];
    for (let i = 0; i < 50 && enriched.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const tl = (await (await fetch(`${base}/control/timeline`)).json()) as {
        events: Array<{ type: string; note?: string }>;
      };
      enriched = tl.events.filter((e) => e.type === "enriched");
    }
    expect(enriched.length).toBe(1);
    // The audit note survives the public-route mapper (live-check regression).
    expect((enriched[0] as { note?: string | null }).note).toContain(
      "via stub:sonnet@low",
    );
    const list = (await (await fetch(`${base}/control/list`)).json()) as {
      frames: Array<{ id: string; title: string; summary: string | null }>;
    };
    const t1 = list.frames.find((f) => f.id === "t1")!;
    expect(t1.title).toBe("API key rotation");
    expect(t1.summary).toContain("staged runbook");
  } finally {
    proxy?.stop();
    stub.stop();
  }
});

test("proxy: WITHOUT the enrich opt nothing enriches (default quota-free posture)", async () => {
  const stub: StubUpstream = startStubUpstream();
  let proxy: ProxyHandle | null = null;
  try {
    // opts.enrich omitted AND env gate absent → envEnrichClient() is null here
    // because bun test runs without CC_ENRICH_ON_INGEST.
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, framesDir });
    const base = `http://localhost:${proxy.port}`;
    await (
      await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...HEAD, messages: [u1] }),
      })
    ).text();
    await new Promise((r) => setTimeout(r, 50));
    const tl = (await (await fetch(`${base}/control/timeline`)).json()) as {
      events: Array<{ type: string }>;
    };
    expect(tl.events.filter((e) => e.type === "enriched")).toHaveLength(0);
    const list = (await (await fetch(`${base}/control/list`)).json()) as {
      frames: Array<{ id: string; title: string }>;
    };
    expect(list.frames.find((f) => f.id === "t1")!.title).toBe("frame t1");
  } finally {
    proxy?.stop();
    stub.stop();
  }
});
