#!/usr/bin/env bash
# Real end-to-end validation: drive ACTUAL Claude Code through the proxy and prove
# model-unaware deletion against the LIVE model — using subscription auth (no API key).
#
# A/B design (self-diagnosing):
#   Scenario A — keep the frame  → the model should still recall the secret.
#   Scenario B — delete the frame → the model should NOT recall it.
# If B still recalls it (e.g. auto-memory leaked the fact), the test FAILS and tells us,
# rather than quietly passing. Each scenario gets its OWN fresh proxy on its OWN port
# (clean frame state, no restart-same-port races) and a fresh Claude Code session; turn 2
# resumes the session, so the unaware agent resends the full transcript and the proxy
# must reconcile our deletion against that resend.
#
#   bash scripts/live-e2e.sh
set -uo pipefail

ROOT=/home/nil/nil/context-composer
CLAUDE=/home/nil/.local/bin/claude
WORK=/tmp/cc-live-test
SECRET="ZEPHYR-7291"
PORT=0   # set per scenario
mkdir -p "$WORK"

claude_turn() { # $1 = session flag(s) (unquoted on purpose), $2 = prompt
  ( cd "$WORK" && timeout 150 \
      env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_TMPDIR -u CLAUDE_PLUGIN_DATA \
      ANTHROPIC_BASE_URL="http://localhost:$PORT" \
      "$CLAUDE" -p "$2" $1 --output-format text --permission-mode bypassPermissions --model sonnet 2>/dev/null )
}

wait_ready() { # poll until the control API answers
  for _ in $(seq 1 40); do
    curl -sf "localhost:$PORT/control/list" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}

scenario() { # $1 = label, $2 = do_delete(yes/no), $3 = port ; sets SECRET_PRESENT
  local label="$1" do_delete="$2"
  PORT="$3"
  CC_PROXY_PORT="$PORT" bun "$ROOT/src/proxy/server.ts" >"/tmp/cc_e2e_proxy_$PORT.log" 2>&1 &
  local PROXY_PID=$!
  if ! wait_ready; then
    echo "── Scenario $label: PROXY FAILED TO START on $PORT"; sed -n '1,6p' "/tmp/cc_e2e_proxy_$PORT.log"
    kill "$PROXY_PID" 2>/dev/null; SECRET_PRESENT=error; return
  fi

  local SID; SID=$(cat /proc/sys/kernel/random/uuid)
  claude_turn "--session-id $SID" "My secret passphrase is $SECRET. Reply with only: OK" >/dev/null

  local note="(frame kept)"
  if [ "$do_delete" = "yes" ]; then
    local fid
    fid=$(curl -s "localhost:$PORT/control/list" | bun -e 'const j=await Bun.stdin.json();const f=j.frames.find(x=>x.kind==="turn"&&!x.deleted);process.stdout.write(f?f.id:"")')
    curl -s -X POST "localhost:$PORT/control/delete" -H 'content-type: application/json' -d "{\"ids\":[\"$fid\"]}" >/dev/null
    note="(deleted frame $fid)"
  fi

  local answer
  answer=$(claude_turn "--resume $SID" "What passphrase did I tell you earlier? Reply with only the passphrase, or NONE if it is not in your context.")

  kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null

  echo "── Scenario $label $note"
  echo "   turn-2 answer: $(printf '%s' "$answer" | tr '\n' ' ' | head -c 100)"
  if printf '%s' "$answer" | grep -q "$SECRET"; then
    echo "   → model HAS the secret"; SECRET_PRESENT=yes
  else
    echo "   → model does NOT have the secret"; SECRET_PRESENT=no
  fi
}

echo "════════ Real Claude Code ⇄ proxy: model-unaware delete (A/B) ════════"
echo
scenario "A — keep"   no  8790; A=$SECRET_PRESENT
echo
scenario "B — delete" yes 8791; B=$SECRET_PRESENT
echo
echo "─────────────────────────────────────────────────────────────────────"
if [ "$A" = "yes" ] && [ "$B" = "no" ]; then
  echo "✅ PASS — deleting the frame removed the secret from the model's view,"
  echo "          while the unaware agent kept resending it. (A recalled, B did not.)"
  exit 0
else
  echo "❌ RESULT — A=$A B=$B (expected A=yes, B=no)."
  echo "          If B=yes, the fact leaked back (likely auto-memory) — needs sealing."
  exit 1
fi
