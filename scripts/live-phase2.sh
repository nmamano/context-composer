#!/usr/bin/env bash
# Real end-to-end validation of PHASE 2 (versioning spine) against ACTUAL Claude Code,
# using subscription auth (no API key). Proves the things Phase 2 added — a durable store
# that survives process restarts, delete-as-an-inspectable-commit, and revert — all the
# way out to the LIVE model's behavior.
#
# One resumed Claude Code session; the proxy is genuinely killed & restarted between steps
# (same port, same on-disk store), so every "after restart" check is a real reload:
#
#   turn 1   tell the model a secret             -> proxy captures frames + a capture event
#   restart  (durability #1)                      -> ctx list still shows the frames
#   delete   the secret frame                     -> ctx history shows the implicit commit
#   restart  (durability #2)                       -> the commit + tombstone reload
#   turn 2   ask for the secret                   -> model says NONE (delete held across restart)
#   revert   the delete                           -> frame restored (append-only revert commit)
#   restart  (durability #3)                       -> the revert reloads
#   turn 3   ask for the secret                   -> model recalls it (revert is visible to the model)
#
# Self-diagnosing: PASS requires durability AND the live answer flipping NONE -> secret.
#
#   bash scripts/live-phase2.sh
set -uo pipefail

ROOT=/home/nil/nil/context-composer
CLAUDE=/home/nil/.local/bin/claude
WORK=/tmp/cc-live-phase2
STORE="$WORK/store.json"
PORT=8792
SECRET="ZEPHYR-7291"
PROXY_PID=""
mkdir -p "$WORK"
rm -f "$STORE"   # start from a clean store; restarts below reload the SAME path

export CC_PROXY_PORT="$PORT" CC_STORE_PATH="$STORE" CC_CONTROL_URL="http://localhost:$PORT"

cleanup() { [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null; }
trap cleanup EXIT

ctl()     { curl -s "http://localhost:$PORT/control/$1"; }
ctlpost() { curl -s -X POST "http://localhost:$PORT/control/$1" -H 'content-type: application/json' -d "$2"; }
jget()    { bun -e "$1"; }  # reads JSON on stdin

wait_ready() {
  for _ in $(seq 1 40); do
    curl -sf "http://localhost:$PORT/control/list" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}
start_proxy() {
  bun "$ROOT/src/proxy/server.ts" >"$WORK/proxy.log" 2>&1 &
  PROXY_PID=$!
  wait_ready || { echo "❌ proxy failed to start on $PORT"; sed -n '1,8p' "$WORK/proxy.log"; exit 1; }
}
stop_proxy()    { kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; PROXY_PID=""; sleep 0.5; }
restart_proxy() { stop_proxy; start_proxy; }

claude_turn() { # $1 = session flag(s) (unquoted on purpose), $2 = prompt
  ( cd "$WORK" && timeout 150 \
      env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_TMPDIR -u CLAUDE_PLUGIN_DATA \
      ANTHROPIC_BASE_URL="http://localhost:$PORT" \
      "$CLAUDE" -p "$2" $1 --output-format text --permission-mode bypassPermissions --model sonnet 2>/dev/null )
}

show_list()     { ctl list     | jget 'const j=await Bun.stdin.json();for(const f of j.frames)console.log("   "+f.id.padEnd(4)+" "+f.kind.padEnd(9)+(f.deleted?"[deleted]":""))'; }
show_history()  { ctl history  | jget 'const j=await Bun.stdin.json();if(!j.commits.length)console.log("   (no commits)");for(const c of j.commits)console.log("   "+c.id+" "+c.type+" ["+c.affectedFrameIds.join(",")+"]")'; }
show_timeline() { ctl timeline | jget 'const j=await Bun.stdin.json();for(const e of j.events)console.log("   "+e.id+" "+e.type.padEnd(8)+"["+e.frameIds.join(",")+"]"+(e.commitId?" -> "+e.commitId:""))'; }
list_ids()      { ctl list     | jget 'const j=await Bun.stdin.json();process.stdout.write(j.frames.map(f=>f.id).join(","))'; }
commit_count()  { ctl history  | jget 'const j=await Bun.stdin.json();process.stdout.write(String(j.commits.length))'; }
secret_frame()  { ctl list     | jget 'const j=await Bun.stdin.json();const f=j.frames.find(x=>x.kind==="turn"&&!x.deleted);process.stdout.write(f?f.id:"")'; }
is_deleted()    { ctl list     | jget "const j=await Bun.stdin.json();const f=j.frames.find(x=>x.id===\"$1\");process.stdout.write(f&&f.deleted?\"yes\":\"no\")"; }
hr()            { echo "─────────────────────────────────────────────────────────────────────"; }

echo "════════ Real Claude Code ⇄ proxy: PHASE 2 (durable store + history + revert) ════════"
echo
start_proxy
SID=$(cat /proc/sys/kernel/random/uuid)

# ── turn 1: tell the secret ───────────────────────────────────────────────────
claude_turn "--session-id $SID" "My secret passphrase is $SECRET. Reply with only: OK" >/dev/null
echo "TURN 1 — told the model the secret."
echo "   ctx list:";     show_list
echo "   ctx timeline:"; show_timeline
echo

# ── restart #1: frames survive a real restart ─────────────────────────────────
restart_proxy
LIST1=$(list_ids)
echo "RESTART #1 (durability) — ctx list after reload: $LIST1"
echo

# ── delete the secret frame ───────────────────────────────────────────────────
FID=$(secret_frame)
ctlpost delete "{\"ids\":[\"$FID\"]}" >/dev/null
echo "DELETE — ctx delete $FID"
echo "   ctx history:";  show_history
echo "   ctx timeline:"; show_timeline
COMMITS_AFTER_DELETE=$(commit_count)
echo

# ── restart #2: commit + tombstone reload ─────────────────────────────────────
restart_proxy
COMMITS_AFTER_RESTART=$(commit_count)
DELETED_AFTER_RESTART=$(is_deleted "$FID")
echo "RESTART #2 — history commits: $COMMITS_AFTER_RESTART ; frame $FID deleted: $DELETED_AFTER_RESTART"
echo

# ── turn 2: the deleted secret must be invisible to the model ─────────────────
ANS2=$(claude_turn "--resume $SID" "What passphrase did I tell you earlier? Reply with only the passphrase, or NONE if it is not in your context.")
echo "TURN 2 — asked for the secret (delete in effect across the restart):"
echo "   model answer: $(printf '%s' "$ANS2" | tr '\n' ' ' | head -c 80)"
echo

# ── revert ────────────────────────────────────────────────────────────────────
ctlpost revert "{}" >/dev/null
echo "REVERT — ctx revert (no arg → the HEAD delete commit)"
echo "   ctx history:";  show_history
echo "   ctx timeline:"; show_timeline
echo

# ── restart #3: revert reloads ────────────────────────────────────────────────
restart_proxy
echo "RESTART #3 — frame $FID deleted after revert + reload: $(is_deleted "$FID")"
echo

# ── turn 3: the model should recall the secret again ──────────────────────────
# NOTE: deliberately a DIFFERENT wording from turn 2 — two byte-identical user messages
# would collide on the content fingerprint (the documented duplicate-source limitation).
ANS3=$(claude_turn "--resume $SID" "Look back to the very beginning of our conversation. What was the secret passphrase I gave you? Reply with only the passphrase, or NONE if it is not in your context.")
echo "TURN 3 — asked again (after revert):"
echo "   model answer: $(printf '%s' "$ANS3" | tr '\n' ' ' | head -c 80)"
echo

# ── verdict ───────────────────────────────────────────────────────────────────
DUR_OK=yes
printf '%s' "$LIST1" | grep -q "p0" || DUR_OK=no
[ "$COMMITS_AFTER_RESTART" = "$COMMITS_AFTER_DELETE" ] || DUR_OK=no
[ "$DELETED_AFTER_RESTART" = "yes" ] || DUR_OK=no

T2_OK=yes; printf '%s' "$ANS2" | grep -qF "$SECRET" && T2_OK=no   # turn 2 must NOT contain the secret
T3_OK=no;  printf '%s' "$ANS3" | grep -qF "$SECRET" && T3_OK=yes  # turn 3 MUST contain the secret

hr
echo "   durability (frames + commit + tombstone survived 3 restarts): $DUR_OK"
echo "   turn 2 hid the deleted secret:                                $T2_OK"
echo "   turn 3 recalled the secret after revert:                      $T3_OK"
hr
if [ "$DUR_OK" = yes ] && [ "$T2_OK" = yes ] && [ "$T3_OK" = yes ]; then
  echo "✅ PASS — durable store survived real restarts; delete is a persisted, inspectable"
  echo "          commit; revert restored the frame; and the LIVE model's view flipped"
  echo "          NONE → $SECRET across the revert."
  exit 0
else
  echo "❌ RESULT — DUR=$DUR_OK T2=$T2_OK T3=$T3_OK (expected all 'yes')."
  echo "          Proxy log tail:"; sed -n '1,6p' "$WORK/proxy.log"
  exit 1
fi
