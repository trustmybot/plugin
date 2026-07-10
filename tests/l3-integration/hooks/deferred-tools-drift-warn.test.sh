#!/usr/bin/env bash
# Tests for scripts/hooks/deferred-tools-drift-warn.sh.
# Hook contract: on SessionStart, emits additionalContext warning when
# dist/tools/*.js files are newer than the running MCP child process.
# Silent no-op when no child is running or tools are not newer.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/deferred-tools-drift-warn.sh"

TMPDIR_BASE=$(mktemp -d)
PIDS_TO_KILL=()
cleanup() {
  for p in "${PIDS_TO_KILL[@]:-}"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
  rm -rf "$TMPDIR_BASE"
}
trap cleanup EXIT

TOOL_DIR="$TMPDIR_BASE/dist/tools"
mkdir -p "$TOOL_DIR"

# epoch 60 seconds ago — represents the MCP child's start time
PAST_EPOCH=$(( $(date '+%s') - 60 ))
# epoch 60 seconds in the future — represents the MCP child's start time
FUTURE_EPOCH=$(( $(date '+%s') + 60 ))

FAKE_PID=99999

run_hook() {
  echo '{}' | bash "$HOOK" 2>&1 || true
}

test_case "no MCP child running (no PID override, pgrep returns nothing): silent no-op"
out=$(TMB_TOOL_DIR_OVERRIDE="$TOOL_DIR" run_hook)
assert_eq "" "$out" "no child = silent"

test_case "tool dir does not exist: silent no-op"
out=$(TMB_MCP_PID_OVERRIDE="$FAKE_PID" TMB_MCP_START_OVERRIDE="$PAST_EPOCH" \
  TMB_TOOL_DIR_OVERRIDE="$TMPDIR_BASE/nonexistent" run_hook)
assert_eq "" "$out" "missing tool dir = silent"

test_case "MCP child running, all tool files older than child: silent no-op"
# Cross-platform: compute epoch offset, format via GNU '@EPOCH' or BSD '-r EPOCH'.
_old_epoch=$(($(date +%s) - 120))
OLD_MTIME="$(date -d "@$_old_epoch" '+%Y%m%d%H%M.%S' 2>/dev/null || date -r "$_old_epoch" '+%Y%m%d%H%M.%S')"
touch -t "$OLD_MTIME" "$TOOL_DIR/index.js"
touch -t "$OLD_MTIME" "$TOOL_DIR/tasks.js"
out=$(TMB_MCP_PID_OVERRIDE="$FAKE_PID" TMB_MCP_START_OVERRIDE="$PAST_EPOCH" \
  TMB_TOOL_DIR_OVERRIDE="$TOOL_DIR" run_hook)
assert_eq "" "$out" "old files = silent"

test_case "MCP child running, one tool file newer than child: emit additionalContext"
_new_epoch=$(($(date +%s) + 1))
NEW_MTIME="$(date -d "@$_new_epoch" '+%Y%m%d%H%M.%S' 2>/dev/null || date -r "$_new_epoch" '+%Y%m%d%H%M.%S')"
touch -t "$NEW_MTIME" "$TOOL_DIR/index.js"
out=$(TMB_MCP_PID_OVERRIDE="$FAKE_PID" TMB_MCP_START_OVERRIDE="$PAST_EPOCH" \
  TMB_TOOL_DIR_OVERRIDE="$TOOL_DIR" run_hook)
assert_contains "$out" '"hookEventName":"SessionStart"' "JSON event name present"
assert_contains "$out" 'deferred-tools drift' "warning label present"
assert_contains "$out" '#98' "issue reference present"
assert_contains "$out" 'Tier 2' "tier 2 workaround present"
assert_contains "$out" 'additionalContext' "additionalContext key present"

test_case "all tool files older than child (future child start): silent no-op"
touch -t "$OLD_MTIME" "$TOOL_DIR/index.js"
touch -t "$OLD_MTIME" "$TOOL_DIR/tasks.js"
out=$(TMB_MCP_PID_OVERRIDE="$FAKE_PID" TMB_MCP_START_OVERRIDE="$FUTURE_EPOCH" \
  TMB_TOOL_DIR_OVERRIDE="$TOOL_DIR" run_hook)
assert_eq "" "$out" "child started after files = silent"

# --- own-child resolution (no PID override) ---------------------------------
# Without TMB_MCP_PID_OVERRIDE the hook must resolve the CURRENT session's own
# trajectory-server child (walk this session's ancestry to its CC proc, then
# the server whose parent chain contains it) — NOT a bystander project's
# server matched by a global pgrep. Fabricate two trees: an "own" CC with a
# server + hook surrogate, and a bystander CC with a server. TMB_DRIFT_SELF_PID
# pins the ancestry-walk start pid to the own session's hook surrogate.
# The server argv is passed via the environment so the literal path never
# appears in the "CC" bash command line — mirroring production, where a global
# pgrep -f 'trajectory-server/dist/index.js' matches only real server procs.
export SRV_ARGV="node /x/mcp/trajectory-server/dist/index.js"
spawn_live_tree() {
  local pf="$1"
  ( exec -a claude bash -c '
      ( exec -a "$SRV_ARGV" sleep 300 ) &
      echo "SRV $!" >> "'"$pf"'"
      ( exec -a "cc-hook-runner" sleep 300 ) &
      echo "HOOK $!" >> "'"$pf"'"
      wait
    ' ) &
  echo "CC $!" >> "$pf"
  disown "$!" 2>/dev/null || true
}

PF_OWN="$TMPDIR_BASE/own.pids"; : > "$PF_OWN"
PF_BY="$TMPDIR_BASE/by.pids"; : > "$PF_BY"
spawn_live_tree "$PF_OWN"
spawn_live_tree "$PF_BY"
sleep 0.6
OWN_SRV=$(awk '/^SRV/{print $2}' "$PF_OWN")
OWN_HOOK=$(awk '/^HOOK/{print $2}' "$PF_OWN")
OWN_CC=$(awk '/^CC/{print $2}' "$PF_OWN")
BY_SRV=$(awk '/^SRV/{print $2}' "$PF_BY")
BY_HOOK=$(awk '/^HOOK/{print $2}' "$PF_BY")
BY_CC=$(awk '/^CC/{print $2}' "$PF_BY")
PIDS_TO_KILL+=("$OWN_SRV" "$OWN_HOOK" "$OWN_CC" "$BY_SRV" "$BY_HOOK" "$BY_CC")

test_case "own-child resolution names this session's server, not a bystander"
touch -t "$NEW_MTIME" "$TOOL_DIR/index.js"
out=$(TMB_DRIFT_SELF_PID="$OWN_HOOK" TMB_MCP_START_OVERRIDE="$PAST_EPOCH" \
  TMB_TOOL_DIR_OVERRIDE="$TOOL_DIR" run_hook)
assert_contains "$out" "PID $OWN_SRV)" "resolves the own session's server"
assert_not_contains "$out" "PID $BY_SRV)" "never names the bystander server"

summarize
