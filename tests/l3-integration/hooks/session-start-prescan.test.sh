#!/usr/bin/env bash
# Tests for scripts/hooks/session-start-prescan.sh.
# Covers: output is valid JSON, additionalContext is emitted, and cache-friendly
# ordering — stable inventory markers appear before volatile count markers.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/session-start-prescan.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT
DB="$TMPDIR/trajectory.db"

export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO issues (objective, status) VALUES ('test issue', 'open');
  INSERT INTO tasks (issue_id, status) VALUES (1, 'pending');
"

run_hook() {
  bash "$HOOK" 2>/dev/null || true
}

OUT=$(run_hook)

# ---- basic output shape ----

test_case "hook emits non-empty output"

# Check output is non-empty
if [ -z "$OUT" ]; then
  _fail "hook produced empty output"
else
  _pass
fi

test_case "output is valid JSON"
if echo "$OUT" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "output is not valid JSON: $OUT"
fi

test_case "output contains hookSpecificOutput"
assert_contains "$OUT" "hookSpecificOutput" "JSON has hookSpecificOutput"

test_case "output contains SessionStart event"
assert_contains "$OUT" "SessionStart" "JSON has SessionStart"

test_case "additionalContext is a string"
ctx_type=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext | type' 2>/dev/null || echo "MISSING")
assert_eq "string" "$ctx_type" "additionalContext type"

CTX=$(echo "$OUT" | jq -r '.hookSpecificOutput.additionalContext' 2>/dev/null || echo "")

# ---- stable markers present ----

test_case "stable: Top-level dirs line present"
assert_contains "$CTX" "Top-level dirs:" "Top-level dirs line present"

test_case "stable: Stacks detected line present"
assert_contains "$CTX" "Stacks detected:" "Stacks detected line present"

test_case "stable: Architecture docs line present"
assert_contains "$CTX" "Architecture docs:" "Architecture docs line present"

test_case "stable: World model line present"
assert_contains "$CTX" "World model:" "World model line present"

# ---- volatile markers present ----

test_case "volatile: Git branch line present"
assert_contains "$CTX" "Git branch:" "Git branch line present"

test_case "volatile: Open issues line present"
assert_contains "$CTX" "Open issues:" "Open issues line present"

test_case "volatile: Pending tasks line present"
assert_contains "$CTX" "Pending tasks:" "Pending tasks line present"

test_case "volatile: Last 5 commits present"
assert_contains "$CTX" "Last 5 commits:" "Last 5 commits line present"

# ---- cache-friendly ordering: stable before volatile ----
# Strategy: find the byte-offset of a stable marker and a volatile marker;
# assert stable_offset < volatile_offset.

stable_marker="Top-level dirs:"
volatile_marker="Git branch:"

stable_pos=$(echo "$CTX" | grep -b -o "$stable_marker" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
volatile_pos=$(echo "$CTX" | grep -b -o "$volatile_marker" 2>/dev/null | head -1 | cut -d: -f1 || echo "")

test_case "ordering: 'Top-level dirs' (stable) appears before 'Git branch' (volatile)"
if [ -z "$stable_pos" ] || [ -z "$volatile_pos" ]; then
  _fail "could not locate markers: stable_pos=<$stable_pos> volatile_pos=<$volatile_pos>"
elif [ "$stable_pos" -lt "$volatile_pos" ]; then
  _pass
else
  _fail "stable marker at byte $stable_pos should be before volatile marker at byte $volatile_pos"
fi

test_case "ordering: 'World model' (stable) appears before 'Open issues' (volatile)"
wm_pos=$(echo "$CTX" | grep -b -o "World model:" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
oi_pos=$(echo "$CTX" | grep -b -o "Open issues:" 2>/dev/null | head -1 | cut -d: -f1 || echo "")
if [ -z "$wm_pos" ] || [ -z "$oi_pos" ]; then
  _fail "could not locate markers: wm_pos=<$wm_pos> oi_pos=<$oi_pos>"
elif [ "$wm_pos" -lt "$oi_pos" ]; then
  _pass
else
  _fail "world-model marker at byte $wm_pos should be before open-issues marker at byte $oi_pos"
fi

# ---- no-DB graceful exit ----

test_case "missing DB: hook exits silently (no output)"
rm -f "$DB"
out_no_db=$(bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$out_no_db" "no output when DB missing"

summarize
