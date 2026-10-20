#!/usr/bin/env bash
# Tests for scripts/hooks/plugin-hooks-marker.sh — the SessionStart hook that
# marks a session as running the plugin's own hooks, read by the headless shim.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/plugin-hooks-marker.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/tmb-plugin-hooks-marker.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
unset CLAUDE_PLUGIN_ROOT TRAJECTORY_DB_PATH

PROJECT="$TMP/project"
mkdir -p "$PROJECT/.claude/tmb"
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" "CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER);"
SESSIONS="$PROJECT/.claude/tmb/sessions"

run() { printf '%s' "$1" | CLAUDE_PROJECT_DIR="$2" bash "$HOOK"; }

test_case "onboarded project: writes a 0-byte marker for the session"
out=$(run '{"session_id":"abc-123","hook_event_name":"SessionStart"}' "$PROJECT")
assert_eq "" "$out" "silent"
assert_eq "yes" "$([ -f "$SESSIONS/abc-123.plugin-hooks" ] && echo yes || echo no)" "marker written"
assert_eq "0" "$(wc -c < "$SESSIONS/abc-123.plugin-hooks" | tr -d ' ')" "marker is empty"

test_case "markers older than 24 h are pruned, fresh ones kept"
: > "$SESSIONS/old.plugin-hooks"
touch -t 202001010000 "$SESSIONS/old.plugin-hooks"
run '{"session_id":"def-456"}' "$PROJECT" >/dev/null
assert_eq "no" "$([ -e "$SESSIONS/old.plugin-hooks" ] && echo yes || echo no)" "stale marker pruned"
assert_eq "yes" "$([ -f "$SESSIONS/abc-123.plugin-hooks" ] && echo yes || echo no)" "fresh marker kept"

test_case "un-onboarded project: nothing written"
mkdir -p "$TMP/bare"
run '{"session_id":"abc-123"}' "$TMP/bare" >/dev/null
assert_eq "no" "$([ -e "$TMP/bare/.claude" ] && echo yes || echo no)" "no state dir created"

test_case "unsafe or missing session_id: nothing written"
before=$(find "$SESSIONS" -type f | wc -l | tr -d ' ')
run '{"session_id":"../escape"}' "$PROJECT" >/dev/null
run '{}' "$PROJECT" >/dev/null
assert_eq "$before" "$(find "$SESSIONS" -type f | wc -l | tr -d ' ')" "no new marker"
assert_eq "no" "$([ -e "$PROJECT/.claude/escape.plugin-hooks" ] && echo yes || echo no)" "no path escape"

test_case "without CLAUDE_PROJECT_DIR the marker follows the resolved DB"
(cd "$PROJECT" && printf '%s' '{"session_id":"walk-1"}' | env -u CLAUDE_PROJECT_DIR -u TMB_TEST_RUN_ID -u TMB_FORBID_LIVE_SYNC bash "$HOOK")
assert_eq "yes" "$([ -f "$SESSIONS/walk-1.plugin-hooks" ] && echo yes || echo no)" "marker written via walk-up"

summarize
