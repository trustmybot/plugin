#!/usr/bin/env bash
# Tests for scripts/hooks/session-log-capture.sh.
# Hook contract: on UserPromptSubmit, append a JSONL event line to
# <workspace>/.claude/tmb/logs/<date>-<session-id>.jsonl.
# Silent no-op when workspace not detected.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/session-log-capture.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

setup_workspace() {
  local ws="$1"
  mkdir -p "$ws/.claude/tmb/logs"
  touch "$ws/.claude/tmb/trajectory.db"
  export TRAJECTORY_DB_PATH="$ws/.claude/tmb/trajectory.db"
}

run_hook() {
  local input="$1"
  echo "$input" | bash "$HOOK" 2>&1 || true
}

# ---- happy path ----

test_case "creates log file and appends JSONL event line"
WS="$TMPDIR/ws1"
setup_workspace "$WS"
SENTINEL="$WS/.claude/tmb/.current-session-id"
printf 'test-session-001' > "$SENTINEL"

INPUT='{"prompt":"hello world","additionalContext":"some ctx"}'
out=$(run_hook "$INPUT")
assert_contains "$out" '"continue": true' "emits continue"

TODAY=$(date -u +%Y-%m-%d)
LOG="$WS/.claude/tmb/logs/${TODAY}-test-session-001.jsonl"
[ -f "$LOG" ] || { echo "FAIL: log file not created at $LOG"; exit 1; }

LINE=$(head -1 "$LOG")
assert_contains "$LINE" '"event":"user_prompt"' "event field present"
assert_contains "$LINE" '"prompt":"hello world"' "prompt captured"
assert_contains "$LINE" '"additional_context":"some ctx"' "additional_context captured"
assert_contains "$LINE" '"ts"' "timestamp field present"

test_case "appends multiple lines on repeated invocation"
WS="$TMPDIR/ws2"
setup_workspace "$WS"
SENTINEL="$WS/.claude/tmb/.current-session-id"
printf 'test-session-002' > "$SENTINEL"

run_hook '{"prompt":"first"}' >/dev/null
run_hook '{"prompt":"second"}' >/dev/null

TODAY=$(date -u +%Y-%m-%d)
LOG="$WS/.claude/tmb/logs/${TODAY}-test-session-002.jsonl"
LINE_COUNT=$(wc -l < "$LOG" | tr -d ' ')
assert_eq "2" "$LINE_COUNT" "two lines in log"

test_case "auto-creates session sentinel if missing"
WS="$TMPDIR/ws3"
setup_workspace "$WS"
SENTINEL="$WS/.claude/tmb/.current-session-id"
[ ! -f "$SENTINEL" ] || rm "$SENTINEL"

run_hook '{"prompt":"auto session"}' >/dev/null

[ -f "$SENTINEL" ] || { echo "FAIL: sentinel not created"; exit 1; }
SESSION_ID=$(cat "$SENTINEL")
[ -n "$SESSION_ID" ] || { echo "FAIL: sentinel is empty"; exit 1; }

TODAY=$(date -u +%Y-%m-%d)
LOG="$WS/.claude/tmb/logs/${TODAY}-${SESSION_ID}.jsonl"
[ -f "$LOG" ] || { echo "FAIL: log file not found at $LOG"; exit 1; }
echo "  sentinel=$SESSION_ID"

# ---- no-op path ----

test_case "silent no-op when workspace not detected (no DB)"
unset TRAJECTORY_DB_PATH
WORKSPACE_NO_DB="$TMPDIR/ws-no-db"
mkdir -p "$WORKSPACE_NO_DB"

# Run from directory that has no DB in the walk-up chain
out=$(cd "$WORKSPACE_NO_DB" && echo '{"prompt":"lost"}' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "no output when no workspace detected"

summarize
