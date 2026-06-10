#!/usr/bin/env bash
# §11 Phase 5a — UI browser-smoke gate (the standing UI gate from 5a on).
#
# Boots a FRESH proxy daemon on its own port/store/wiretap/frames dir under
# /tmp/cc-ui-smoke-* (never 8788, never a live daemon's state), seeded with the
# committed real-TUI-session fixture, builds the UI, then drives the system
# Chrome via Playwright (scripts/ui-smoke.ts) judging against the control API.
# Default bun test never runs this (needs Chrome + a daemon) — invoke with
# `bun run ui:smoke`. Override the daemon port with CC_UI_SMOKE_PORT and the
# store fixture with CC_UI_SMOKE_FIXTURE (e.g. a live capture during a TUI smoke).

set -euo pipefail
cd "$(dirname "$0")/.."

FIXTURE="${CC_UI_SMOKE_FIXTURE:-test/fixtures/ui-smoke-store.json}"
PORT="${CC_UI_SMOKE_PORT:-8806}" # own port — avoid 8788 (live) and 8796/8797/8799 (fixed test ports)
SMOKE_DIR="$(mktemp -d /tmp/cc-ui-smoke-XXXXXX)"

if [[ ! -f "$FIXTURE" ]]; then
  echo "[ui-smoke] fixture not found: $FIXTURE" >&2
  exit 2
fi

echo "[ui-smoke] evidence dir: $SMOKE_DIR"
echo "[ui-smoke] building UI…"
bun run ui:build >/dev/null

cp "$FIXTURE" "$SMOKE_DIR/store.json"
mkdir -p "$SMOKE_DIR/frames"

echo "[ui-smoke] starting smoke daemon on :$PORT (own store/wiretap/frames; LLM env scrubbed)…"
# env -u CC_LLM_*: regen must be UNAVAILABLE in this gate so regen clicks are
# daemon refusals, never upstream LLM calls — keeps the op smoke quota-free
# (§11 Phase 5b reviewer guardrail).
env -u CC_LLM_API_KEY -u CC_LLM_MODEL \
CC_PROXY_PORT="$PORT" \
CC_STORE_PATH="$SMOKE_DIR/store.json" \
CC_WIRETAP_PATH="$SMOKE_DIR/wiretap.jsonl" \
CC_FRAMES_DIR="$SMOKE_DIR/frames" \
  bun run src/proxy/server.ts >"$SMOKE_DIR/daemon.log" 2>&1 &
DAEMON=$!
trap 'kill "$DAEMON" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl -fsS "http://localhost:$PORT/control/conversations" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! curl -fsS "http://localhost:$PORT/control/conversations" >/dev/null 2>&1; then
  echo "[ui-smoke] daemon failed to come up — log:" >&2
  cat "$SMOKE_DIR/daemon.log" >&2
  exit 1
fi

echo "[ui-smoke] driving system Chrome (headless) against http://localhost:$PORT/ui …"
CC_SMOKE_BASE="http://localhost:$PORT" CC_SMOKE_DIR="$SMOKE_DIR" \
  bun run scripts/ui-smoke.ts

echo "[ui-smoke] PASS — evidence in $SMOKE_DIR"
