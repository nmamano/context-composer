// §11 Phase 5a — /ui route-table coverage (reviewer condition on the
// daemon-served choice): /ui is OWNED-LOCAL (never passthrough), unknown
// /control routes still stay local, traversal is refused, the SPA index
// fallback exists only under /ui, and every non-owned route still passes
// through untouched (the Phase 2.5 invariant the static route must not dent).
//
// Same harness style as passthrough.test.ts: the REAL Bun.serve route table
// against the stub upstream, with a tmp uiDistDir (the storePath/framesDir
// test-seam pattern).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startProxy, type ProxyHandle } from "../src/proxy/server.ts";
import { startStubUpstream, type StubUpstream } from "./stub-upstream.ts";

let proxy: ProxyHandle;
let stub: StubUpstream;
let tmp: string;
let dist: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cc-ui-routes-"));
  dist = join(tmp, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>cc-ui</title>");
  writeFileSync(join(dist, "app.js"), "console.log('cc-ui')");
  // A sibling OUTSIDE dist — the traversal target that must never be served.
  writeFileSync(join(tmp, "secret.txt"), "do-not-serve");
  stub = startStubUpstream();
  proxy = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, uiDistDir: dist });
});
afterEach(() => {
  proxy.stop();
  stub.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const base = () => `http://localhost:${proxy.port}`;

test("GET /ui serves the local shell — never passthrough", async () => {
  const res = await fetch(`${base()}/ui`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("cc-ui");
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(stub.nonOwned).toHaveLength(0); // nothing leaked upstream
});

test("GET /ui/app.js serves the asset with its content type", async () => {
  const res = await fetch(`${base()}/ui/app.js`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("cc-ui");
  expect(res.headers.get("content-type")).toContain("javascript");
  expect(stub.nonOwned).toHaveLength(0);
});

test("unknown /ui subpath falls back to index.html (SPA fallback under /ui only)", async () => {
  const res = await fetch(`${base()}/ui/some/client/route`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("cc-ui");
  expect(stub.nonOwned).toHaveLength(0);
});

test("path traversal is refused locally (encoded-slash dot-segments)", async () => {
  // Literal "../" and "%2e%2e" dot-segments are normalized away by WHATWG URL
  // parsing before they ever reach the route table ("/ui/../x" simply isn't a
  // /ui path). The vector that DOES reach handleUi is an encoded slash —
  // "..%2f" survives URL normalization, then decodeURIComponent yields "../".
  // The resolved-path containment check must refuse it locally.
  const res = await fetch(`${base()}/ui/..%2fsecret.txt`);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("do-not-serve");
  expect(stub.nonOwned).toHaveLength(0);
});

test("non-GET /ui is refused locally (static surface is read-only)", async () => {
  const res = await fetch(`${base()}/ui/app.js`, { method: "POST", body: "x" });
  expect(res.status).toBe(405);
  expect(stub.nonOwned).toHaveLength(0);
});

test("HEAD /ui works (no body, html content type)", async () => {
  const res = await fetch(`${base()}/ui`, { method: "HEAD" });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
  expect(stub.nonOwned).toHaveLength(0);
});

test("/ui-prefixed but non-/ui paths still pass through (e.g. /uikit)", async () => {
  stub.enqueuePassthrough({
    status: 200,
    contentType: "application/json",
    body: '{"ok":true}',
  });
  const res = await fetch(`${base()}/uikit`);
  expect(res.status).toBe(200);
  expect(stub.nonOwned).toHaveLength(1);
  expect(stub.nonOwned[0]!.path).toBe("/uikit");
});

test("unknown /control route stays a LOCAL 404 — never leaks upstream", async () => {
  const res = await fetch(`${base()}/control/definitely-not-a-route`);
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain("unknown control route");
  expect(stub.nonOwned).toHaveLength(0);
});

test("unbuilt UI yields a clear local 404, not passthrough", async () => {
  const empty = join(tmp, "empty-dist");
  mkdirSync(empty);
  const p2 = startProxy({ port: 0, upstreamBaseUrl: stub.baseUrl, uiDistDir: empty });
  try {
    const res = await fetch(`http://localhost:${p2.port}/ui`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("UI not built");
    expect(stub.nonOwned).toHaveLength(0);
  } finally {
    p2.stop();
  }
});
