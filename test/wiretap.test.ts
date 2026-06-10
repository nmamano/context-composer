// §11 Phase 2.6 acceptance — WIRETAP: every owned exchange leaves raw evidence (exact inbound
// body, composed outbound body, redacted headers, upstream status), and passthrough
// traffic leaves a light line. Secrets never touch disk.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-tap-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("owned exchanges and passthrough hits are tapped; auth headers are redacted", async () => {
  const stub: StubUpstream = startStubUpstream();
  const tapPath = join(dir, "tap.jsonl");
  let proxy: ProxyHandle | undefined;
  try {
    proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, wiretapPath: tapPath });
    const base = `http://localhost:${proxy.port}`;

    stub.enqueue({ text: "ok", stopReason: "end_turn" });
    await (await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "SUPER-SECRET-KEY",
        authorization: "Bearer SUPER-SECRET-TOKEN",
        "anthropic-beta": "some-beta-2026",
      },
      body: JSON.stringify({
        model: "m",
        max_tokens: 8,
        system: "SYS",
        messages: [{ role: "user", content: "hello" }],
      }),
    })).text();

    stub.enqueuePassthrough({ body: "{}" });
    await (await fetch(`${base}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).text();

    // The tap holds conversation content — it must be created private (0600).
    expect(statSync(tapPath).mode & 0o777).toBe(0o600);

    const lines = readFileSync(tapPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);

    const owned = lines[0]!;
    expect(owned.kind).toBe("messages");
    // Inbound is kept as RAW BYTES (byte-exact replay evidence), not a re-parse.
    expect(typeof owned.inbound.rawBody).toBe("string");
    expect(JSON.parse(owned.inbound.rawBody).messages).toEqual([
      { role: "user", content: "hello" },
    ]);
    expect(owned.outboundBody.messages).toBeDefined();
    expect(owned.upstreamStatus).toBe(200);
    expect(owned.wireWarnings).toEqual([]);
    // Secrets redacted; non-secret protocol headers preserved (they are evidence).
    expect(owned.inbound.headers["x-api-key"]).toBe("<redacted>");
    expect(owned.inbound.headers["authorization"]).toBe("<redacted>");
    expect(owned.inbound.headers["anthropic-beta"]).toBe("some-beta-2026");
    expect(JSON.stringify(lines)).not.toContain("SUPER-SECRET");

    const pass = lines[1]!;
    expect(pass.kind).toBe("passthrough");
    expect(pass.path).toBe("/v1/messages/count_tokens");
    expect(pass.status).toBe(200);
    expect(pass.inbound).toBeUndefined(); // light line — no bodies on passthrough
  } finally {
    proxy?.stop();
    stub.stop();
  }
});
