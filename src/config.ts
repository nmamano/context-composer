// Central runtime configuration for the Phase 1 tracer bullet.
//
// The proxy daemon and the `ctx` CLI must agree on where the control API lives;
// both read from here so a single env var moves them together.

export const PROXY_PORT = Number(process.env.CC_PROXY_PORT ?? 8788);

// Where the wrapped agent / tests reach the proxy + control API.
export const CONTROL_BASE_URL =
  process.env.CC_CONTROL_URL ?? `http://localhost:${PROXY_PORT}`;

// Upstream the proxy forwards rewritten /v1/messages to. Defaults to the real
// Anthropic API; tests point this at a local stub upstream.
export const UPSTREAM_BASE_URL =
  process.env.CC_UPSTREAM_URL ?? "https://api.anthropic.com";

// Durable store path for the proxy daemon (Phase 2). A restart reloads this file's
// frame state + commit graph. Tests/library callers pass their own path (or none, for
// in-memory) — this default applies only to the daemon entrypoint.
export const STORE_PATH = process.env.CC_STORE_PATH ?? "./.ctx-store.json";
