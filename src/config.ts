// Central runtime configuration for the Phase 1 tracer bullet.

import { resolve } from "node:path";

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

// Durable store path for the proxy daemon (Phase 2; a conversation REGISTRY since
// §11 Phase 2.6). A restart reloads every conversation's frame state + commit graph.
// Tests/library callers pass their own path (or none, for in-memory) — this default
// applies only to the daemon entrypoint.
export const STORE_PATH = process.env.CC_STORE_PATH ?? "./.ctx-store.json";

// Wiretap (§11 Phase 2.6): JSONL raw wire evidence — exact inbound body, composed outbound
// body, redacted headers, upstream status/error per owned request. Daemon-only
// default; tests opt in with their own path. Set CC_WIRETAP_PATH=off to disable.
const wiretapEnv = process.env.CC_WIRETAP_PATH ?? "./.ctx-wiretap.jsonl";
export const WIRETAP_PATH = wiretapEnv === "off" ? undefined : wiretapEnv;

// Offload artifacts (§11 Phase 3b): rendered frame content the wrapped agent
// reads back with its own file-read tool. Resolved to an ABSOLUTE path at load —
// the agent's cwd is not ours, so the stub must carry an absolute reference.
// Local-only conversation data: dir 0700, files 0600, gitignored.
export const FRAMES_DIR = resolve(process.env.CC_FRAMES_DIR ?? "./.ctx-frames");
