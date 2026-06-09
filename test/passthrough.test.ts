// Phase 2.5 acceptance — TRANSPARENT PASSTHROUGH (design.md §11).
//
// Any request the proxy does NOT own (anything but the rewritten `POST /v1/messages` and
// the local `/control/*` API) must be piped to the real upstream untouched and the response
// returned verbatim — the de-risking slice that lets a real interactive TUI (count_tokens,
// model lookups, etc.) round-trip instead of 404ing.
//
// Driven through the REAL HTTP proxy against the stub upstream (same harness style as
// loop.test.ts), so this exercises the actual Bun.serve route table, not a pure function.
//
// Covers: byte-for-byte response; verbatim method/path/query/body/auth; GET (no body) vs
// POST; SSE streamed (not buffered); content-type NOT coerced on passthrough; the engine is
// bypassed entirely (no frames/commits/events); route-order invariants (owned routes win,
// unknown /control stays a LOCAL 404 and never leaks upstream).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let proxy: ProxyHandle;
let stub: StubUpstream;

beforeEach(() => {
  stub = startStubUpstream();
  proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl });
});
afterEach(() => {
  proxy.stop();
  stub.stop();
});

const base = () => `http://localhost:${proxy.port}`;
const control = async (path: string): Promise<any> =>
  (await fetch(`${base()}/control/${path}`)).json();

test("non-owned POST is forwarded untouched and returned byte-for-byte", async () => {
  const respBody = JSON.stringify({ input_tokens: 1234 });
  stub.enqueuePassthrough({ status: 200, contentType: "application/json", body: respBody });

  const reqBody = JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "hi" }] });
  const res = await fetch(`${base()}/v1/messages/count_tokens?beta=true`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "sekret-key",
      "anthropic-version": "2023-06-01",
    },
    body: reqBody,
  });

  // Response returned byte-for-byte.
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(respBody);

  // Upstream saw the request verbatim: method / path / query / body / auth / version.
  expect(stub.nonOwned).toHaveLength(1);
  const got = stub.nonOwned[0];
  expect(got.method).toBe("POST");
  expect(got.path).toBe("/v1/messages/count_tokens");
  expect(got.search).toBe("?beta=true");
  expect(got.body).toBe(reqBody); // byte-exact payload
  expect(got.headers["x-api-key"]).toBe("sekret-key");
  expect(got.headers["anthropic-version"]).toBe("2023-06-01");

  // The owned `/v1/messages` handler was NOT invoked.
  expect(stub.received).toHaveLength(0);
});

test("non-owned GET with query is forwarded and carries no request body", async () => {
  stub.enqueuePassthrough({ body: `{"ok":true}` });
  const res = await fetch(`${base()}/v1/models?limit=5`, {
    method: "GET",
    headers: { "x-api-key": "k2", "anthropic-version": "2023-06-01" },
  });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(`{"ok":true}`);

  const got = stub.nonOwned[0];
  expect(got.method).toBe("GET");
  expect(got.path).toBe("/v1/models");
  expect(got.search).toBe("?limit=5");
  expect(got.body).toBe(""); // no body attached for GET
});

test("SSE passthrough response is streamed back verbatim (not buffered)", async () => {
  const sse = 'event: ping\ndata: {"n":1}\n\nevent: ping\ndata: {"n":2}\n\n';
  stub.enqueuePassthrough({ status: 200, contentType: "text/event-stream", body: sse });

  const res = await fetch(`${base()}/v1/some/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(await res.text()).toBe(sse); // exact bytes round-trip
});

test("passthrough forwards content-type verbatim (does NOT coerce to JSON)", async () => {
  stub.enqueuePassthrough({ body: "pong" });
  await fetch(`${base()}/v1/raw`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "ping",
  });
  // The owned path forces application/json; passthrough must not.
  expect(stub.nonOwned[0].headers["content-type"]).toBe("text/plain");
});

test("passthrough bypasses the engine entirely (no frames / commits / events)", async () => {
  stub.enqueuePassthrough({ body: "{}" });
  await fetch(`${base()}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  // No ingest/compose ran: the FrameStore and both logs are untouched (public surfaces).
  expect((await control("list")).frames).toHaveLength(0);
  expect((await control("history")).commits).toHaveLength(0);
  expect((await control("timeline")).events).toHaveLength(0);
});

test("GET /v1/messages (not POST) passes through — we own exactly POST /v1/messages", async () => {
  stub.enqueuePassthrough({ body: "ok" });
  const res = await fetch(`${base()}/v1/messages`, { method: "GET" });
  expect(await res.text()).toBe("ok");

  expect(stub.nonOwned[0].method).toBe("GET");
  expect(stub.nonOwned[0].path).toBe("/v1/messages");
  expect(stub.received).toHaveLength(0); // the owned handler never ran
});

test("unknown /control route stays a LOCAL 404 and never leaks upstream", async () => {
  const res = await fetch(`${base()}/control/bogus`);
  expect(res.status).toBe(404);
  const j = (await res.json()) as { error: string };
  expect(j.error).toContain("unknown control route"); // local handler, not passthrough
  expect(stub.nonOwned).toHaveLength(0); // route order held: never forwarded
});
