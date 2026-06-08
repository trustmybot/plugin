#!/usr/bin/env bash
# Tests for scripts/hooks/deferred-tools-drift-warn.sh.
# Hook contract: on SessionStart, emits additionalContext warning when
# dist/tools/*.js files are newer than the running MCP child process.
# Silent no-op when no child is running or tools are not newer.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/deferred-tools-drift-warn.sh"

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

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

summarize
