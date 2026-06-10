#!/usr/bin/env bash
# §11 Phase 5d — LIVE subscription-regen check (5d-ONLY validation, not a
# standing per-slice gate: regen paths freeze after this slice).
#
# ⚠ BURNS SUBSCRIPTION QUOTA: ~2 `claude -p` completions (one ctx retitle
# --regen, one browser retitle-regen click). Run explicitly:
#   CC_LLM_CLAUDE_CLI=1 bash scripts/live-regen.sh
#
# REQUIRES the explicit opt-in: fails clearly when CC_LLM_CLAUDE_CLI=1 is
# absent — it never falls back to API config (CC_LLM_API_KEY/CC_LLM_MODEL are
# scrubbed below so precedence cannot silently route regen to an API key).
# Boots a FRESH daemon on its own port/store/wiretap/frames (never 8788),
# seeded with the committed fixture; judges via /control/show + /control/
# history (+ list for the browser leg), not DOM alone.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${CC_LLM_CLAUDE_CLI:-}" != "1" ]]; then
  echo "[live-regen] REFUSING: CC_LLM_CLAUDE_CLI=1 is required (this gate burns ~2 subscription completions; set it explicitly)" >&2
  exit 2
fi

FIXTURE="${CC_UI_SMOKE_FIXTURE:-test/fixtures/ui-smoke-store.json}"
PORT="${CC_LIVE_REGEN_PORT:-8810}"
SMOKE_DIR="$(mktemp -d /tmp/cc-live-regen-XXXXXX)"
BASE="http://localhost:$PORT"

echo "[live-regen] evidence dir: $SMOKE_DIR (burns ~2 subscription completions)"
bun run ui:build >/dev/null
cp "$FIXTURE" "$SMOKE_DIR/store.json"
mkdir -p "$SMOKE_DIR/frames"

# API env scrubbed: precedence must not silently route to an API key — this
# gate validates the SUBSCRIPTION path. CC_CLAUDE_BIN/CC_LLM_CLI_* pass through.
env -u CC_LLM_API_KEY -u CC_LLM_MODEL \
CC_LLM_CLAUDE_CLI=1 \
CC_PROXY_PORT="$PORT" \
CC_STORE_PATH="$SMOKE_DIR/store.json" \
CC_WIRETAP_PATH="$SMOKE_DIR/wiretap.jsonl" \
CC_FRAMES_DIR="$SMOKE_DIR/frames" \
  bun run src/proxy/server.ts >"$SMOKE_DIR/daemon.log" 2>&1 &
DAEMON=$!
trap 'kill "$DAEMON" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  curl -fsS "$BASE/control/conversations" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "$BASE/control/conversations" >/dev/null

echo "[live-regen] leg 1: ctx retitle --regen (subscription completion #1)…"
CC_SMOKE_BASE="$BASE" CC_SMOKE_DIR="$SMOKE_DIR" \
  bun run scripts/live-regen.ts cli

echo "[live-regen] leg 2: browser retitle regen click (subscription completion #2)…"
CC_SMOKE_BASE="$BASE" CC_SMOKE_DIR="$SMOKE_DIR" \
  bun run scripts/live-regen.ts browser

echo "[live-regen] PASS — both regen legs ran on the subscription CLI; evidence in $SMOKE_DIR"
