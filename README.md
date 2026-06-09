# Context Composer

Live, in-conversation, model-unaware surgery on the working context, at the
frame/turn level. See [`design.md`](./design.md) for the full design.

## Status: Phase 1 — tracer bullet (engine loop end-to-end)

The proxy intercepts at the rendered-context boundary, decomposes each
`/v1/messages` request into frames, reconciles it against authoritative in-memory
state, lets you `delete` frames via the CLI, recomposes deterministically, and
forwards — all without the model seeing the operations.

Implemented: `proxy` (boundary + control API) · `decompose` · `reconcile`
(tombstones + greedy ordered match) · `compose` (deletions omitted, `cache_control`
on the stable head) · canonical serialization · SSE passthrough + capture ·
`ctx` CLI (`list` / `show` / `delete` / `compose`).

Deferred by design: durable store + commit graph + `history`/`revert` (Phase 2),
op breadth (Phase 3), branching (Phase 4), UI (Phase 5).

## Run

```bash
bun install                 # @types/bun (optional; runtime needs nothing)
bun run src/proxy/server.ts # starts proxy + control API on :8788
```

Point the wrapped agent at it and drive frames from another shell:

```bash
ANTHROPIC_BASE_URL=http://localhost:8788   # for the wrapped agent
bun run src/cli/ctx.ts list
bun run src/cli/ctx.ts delete t1
bun run src/cli/ctx.ts compose --dump
bun run src/cli/ctx.ts compose --hash-head
```

Config via env: `CC_PROXY_PORT`, `CC_CONTROL_URL`, `CC_UPSTREAM_URL`.

## Test

```bash
bun test
```

- `test/loop.test.ts` — the full daemon loop through real HTTP against a stub
  upstream: capture → delete → reconcile across a tool_use/tool_result round-trip →
  determinism (byte-stable head + cache breakpoint) → runtime-knob preservation.
- `test/grouping.test.ts` — tool-loop frame grouping and the documented
  duplicate-fingerprint limitation.

## Live-agent smoke (subscription auth — no API keys)

The live run drives a real Claude Code through the proxy using the user's existing
**Claude subscription session** (already authenticated as this Linux user) — **no API
key, ever**. The proxy is credential-agnostic: it forwards whatever auth headers the
agent attaches, untouched. The only wiring is `ANTHROPIC_BASE_URL`:

```bash
bun run src/proxy/server.ts                       # terminal 1: proxy on :8788
ANTHROPIC_BASE_URL=http://localhost:8788 claude   # terminal 2: real convo, sub auth rides along
bun run src/cli/ctx.ts list                       # terminal 3: real frames; delete one; watch next turn
```

Run it with the human in the loop before claiming demo readiness; the stub-driven
suite above is the engineering gate.
