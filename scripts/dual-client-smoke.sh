#!/usr/bin/env bash
# §11 Phase 5b — DUAL-CLIENT smoke: a REAL interactive TUI session and the REAL
# browser on the SAME fresh daemon. Surgery happens IN THE BROWSER mid-session;
# the next TUI turn's wire is judged via the WIRETAP (never the pane/DOM).
#
# ⚠ BURNS SUBSCRIPTION QUOTA (3 short real TUI turns). Not part of bun test or
# ui:smoke — run explicitly per slice: `bash scripts/dual-client-smoke.sh`.
# Requirements: tmux, the `claude` CLI authenticated, Chrome + Playwright.
#
# Rails: own port/store/wiretap/frames under /tmp (never 8788; never a live
# daemon's state); TUI runs in DEFAULT permission mode; LLM env scrubbed so no
# accidental regen calls; tmux driving never blind-Enters (suggestion ghost
# text sits in the input box — every Enter here follows explicit typed text).

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${CC_DUAL_SMOKE_PORT:-8809}"
SMOKE_DIR="$(mktemp -d /tmp/cc-dual-smoke-XXXXXX)"
SESSION="ccdual-$$"
CLAUDE_BIN="${CLAUDE_BIN:-$HOME/.local/bin/claude}"
BASE="http://localhost:$PORT"

echo "[dual-smoke] evidence dir: $SMOKE_DIR"
mkdir -p "$SMOKE_DIR/workdir" "$SMOKE_DIR/frames"
bun run ui:build >/dev/null

echo "[dual-smoke] starting fresh daemon on :$PORT…"
env -u CC_LLM_API_KEY -u CC_LLM_MODEL \
CC_PROXY_PORT="$PORT" \
CC_STORE_PATH="$SMOKE_DIR/store.json" \
CC_WIRETAP_PATH="$SMOKE_DIR/wiretap.jsonl" \
CC_FRAMES_DIR="$SMOKE_DIR/frames" \
  bun run src/proxy/server.ts >"$SMOKE_DIR/daemon.log" 2>&1 &
DAEMON=$!
cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  kill "$DAEMON" 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 50); do
  curl -fsS "$BASE/control/conversations" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "$BASE/control/conversations" >/dev/null

# --- helpers -------------------------------------------------------------------

pane() { tmux capture-pane -t "$SESSION" -p; }

wait_for_pane() { # $1 = grep pattern, $2 = timeout seconds
  local deadline=$(( $(date +%s) + ${2:-60} ))
  while (( $(date +%s) < deadline )); do
    if pane | grep -qE "$1"; then return 0; fi
    sleep 1
  done
  echo "[dual-smoke] TIMEOUT waiting for pane pattern: $1" >&2
  pane | tail -20 >&2
  return 1
}

wiretap_count() { # main-conv messages entries containing $1 in the inbound body
  grep -c "$1" "$SMOKE_DIR/wiretap.jsonl" 2>/dev/null || true
}

wait_for_wire() { # $1 = marker, $2 = timeout seconds — waits for a 200 entry
  local deadline=$(( $(date +%s) + ${2:-90} ))
  while (( $(date +%s) < deadline )); do
    if grep -F "$1" "$SMOKE_DIR/wiretap.jsonl" 2>/dev/null \
       | grep -q '"upstreamStatus":200'; then return 0; fi
    sleep 1
  done
  echo "[dual-smoke] TIMEOUT waiting for wiretap marker: $1" >&2
  tail -3 "$SMOKE_DIR/wiretap.jsonl" >&2 2>/dev/null || true
  return 1
}

send_prompt() { # type text, VERIFY it landed in the input, then submit.
  local text="$1"
  for _ in 1 2 3; do
    tmux send-keys -t "$SESSION" "$text"
    sleep 2
    # The TUI right after startup can swallow keystrokes (5a lesson) — only
    # Enter once the pane actually shows what we typed (never a blind Enter).
    if pane | grep -qF "$text"; then
      tmux send-keys -t "$SESSION" Enter
      return 0
    fi
  done
  echo "[dual-smoke] FAILED to type prompt into the TUI: $text" >&2
  pane | tail -15 >&2
  return 1
}

# --- real TUI session ------------------------------------------------------------

echo "[dual-smoke] launching real TUI (default permission mode)…"
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$SMOKE_DIR/workdir"
tmux send-keys -t "$SESSION" "ANTHROPIC_BASE_URL=$BASE $CLAUDE_BIN" Enter
if wait_for_pane "trust this folder" 30; then
  tmux send-keys -t "$SESSION" Enter   # answer the explicit trust prompt
fi
wait_for_pane "for shortcuts" 60
sleep 3 # let the input box come fully alive before typing (5a lesson)

echo "[dual-smoke] turn 1…"
send_prompt 'Reply with exactly: dual alpha ack.'
wait_for_wire "dual alpha ack" 120

echo "[dual-smoke] turn 2…"
send_prompt 'Reply with exactly: dual bravo ack.'
wait_for_wire "dual bravo ack" 120

echo "[dual-smoke] BROWSER SURGERY on the live session (offload turn-1; edit turn-2 then revert it from the history panel)…"
CC_SMOKE_BASE="$BASE" CC_SMOKE_DIR="$SMOKE_DIR" \
  bun run scripts/dual-client-smoke.ts surgery

echo "[dual-smoke] turn 3 (the unaware resend)…"
send_prompt 'Say done.'
wait_for_wire "Say done" 120

echo "[dual-smoke] judging the post-surgery wire via the wiretap…"
CC_SMOKE_BASE="$BASE" CC_SMOKE_DIR="$SMOKE_DIR" CC_WIRETAP="$SMOKE_DIR/wiretap.jsonl" \
  bun run scripts/dual-client-smoke.ts judge

# Session health: the pane is alive and showing the prompt again (evidence only).
wait_for_pane "for shortcuts" 30
pane | tail -12 > "$SMOKE_DIR/pane-final.txt"

echo "[dual-smoke] PASS — TUI + browser shared one daemon; surgery landed on the next turn's wire."
echo "[dual-smoke] evidence: $SMOKE_DIR (wiretap.jsonl, surgery.png, surgery.json, pane-final.txt)"
