#!/usr/bin/env bash
# L3 tests for scripts/hooks/roundtable-slash-detect.sh
#
# Verifies: (1) /roundtable prompt writes a roundtable_slash_invoked audit row
# using the correct schema (no kind column), (2) non-/roundtable prompts are
# silent no-ops, (3) DB is resolved via tmb_db_path walk-up (no env var).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/roundtable-slash-detect.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 unavailable"; exit 0; }
command -v jq     >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

TMPDIR_RT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RT"' EXIT

DB="$TMPDIR_RT/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$SCHEMA" >/dev/null

run_hook() {
  local prompt="$1"
  echo "{\"prompt\":\"$prompt\"}" \
    | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
}

# ── basic insert ──────────────────────────────────────────────────────────────

test_case "/roundtable prompt inserts audit row with event_type=roundtable_slash_invoked"
run_hook "/roundtable let's deliberate"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
assert_eq "1" "$COUNT" "one audit row must be inserted"

test_case "audit row has correct columns (no kind column used)"
ROW=$(sqlite3 -separator "|" "$DB" "SELECT from_node, event_type FROM audit WHERE event_type='roundtable_slash_invoked' LIMIT 1;")
assert_eq "system|roundtable_slash_invoked" "$ROW" "from_node=system and event_type correct"

# ── non-/roundtable prompt is a no-op ─────────────────────────────────────────

test_case "non-/roundtable prompt writes no audit row"
sqlite3 "$DB" "DELETE FROM audit;"
run_hook "just a normal prompt"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
assert_eq "0" "$COUNT" "no row for non-/roundtable prompt"

test_case "/roundtable in the middle of prompt (after whitespace) is detected"
sqlite3 "$DB" "DELETE FROM audit;"
run_hook "hey /roundtable on this topic"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
assert_eq "1" "$COUNT" "mid-prompt /roundtable detected"

# ── walk-up DB resolution (no TRAJECTORY_DB_PATH) ────────────────────────────
# Plant the DB in a subdirectory and run from a child directory to exercise the
# tmb_db_path walk-up. The hook sources lib/query-task.sh which implements it.

test_case "/roundtable resolves DB via walk-up (no env var)"
WALK_ROOT=$(mktemp -d -t tmb-rt-walk-XXXX)
trap 'rm -rf "$WALK_ROOT"' EXIT
WALK_DB="$WALK_ROOT/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WALK_DB")"
sqlite3 "$WALK_DB" < "$SCHEMA" >/dev/null
CHILD_DIR="$WALK_ROOT/some/nested/path"
mkdir -p "$CHILD_DIR"
PAYLOAD='{"prompt":"/roundtable walk-up test"}'
COUNT_BEFORE=$(sqlite3 "$WALK_DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
(
  cd "$CHILD_DIR" || exit 1
  echo "$PAYLOAD" | bash "$HOOK" 2>&1 || true
)
COUNT_AFTER=$(sqlite3 "$WALK_DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
assert_eq "$((COUNT_BEFORE + 1))" "$COUNT_AFTER" "walk-up must find the DB and insert the row"

# ── injection regression ──────────────────────────────────────────────────────

test_case "injection attempt in prompt: treated as missing (no SQL error, no extra rows)"
sqlite3 "$DB" "DELETE FROM audit;"
run_hook "/roundtable 1; DROP TABLE audit;--"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
# The summary is stored as a literal string; the audit table must still exist
# and have exactly one row (the summary may contain the injection string verbatim).
assert_eq "1" "$COUNT" "one audit row written even with injection string in prompt"
# Confirm the audit table was NOT dropped (verifies the quote-escaping worked).
TABLE_EXISTS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='audit';")
assert_eq "1" "$TABLE_EXISTS" "audit table must still exist after injection attempt"

test_case "prompt with single quotes: stored intact, no SQL error"
sqlite3 "$DB" "DELETE FROM audit;"
run_hook "/roundtable it's a test with o'brien's quote"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
assert_eq "1" "$COUNT" "row inserted with single-quoted prompt"
STORED=$(sqlite3 "$DB" "SELECT summary FROM audit WHERE event_type='roundtable_slash_invoked' LIMIT 1;")
case "$STORED" in
  *"it's"*|*"o'brien"*) echo "  ✓ single quotes preserved in summary" ;;
  *) echo "FAIL: expected single quotes in stored summary, got: $STORED"; exit 1 ;;
esac

# ── prefixed prompt (preamble + newline before /roundtable) ──────────────────
# Exercises the `*$'\n'/roundtable*` matcher arm: a real prompt often carries a
# preamble line before the slash command.

test_case "/roundtable after a preamble + newline is detected"
sqlite3 "$DB" "DELETE FROM audit;"
run_hook "please help me out\n/roundtable pick a design"
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
assert_eq "1" "$COUNT" "prefixed /roundtable after newline detected"

# ── WAL contention ────────────────────────────────────────────────────────────
# A concurrent writer holds BEGIN IMMEDIATE (the write lock) for ~1s. With the
# hook's old busy_timeout=0 the INSERT would fail instantly and drop the row;
# with .timeout 3000 it waits out the lock and the audit row still lands.

test_case "/roundtable audit row lands despite a concurrent write-lock holder"
sqlite3 "$DB" "DELETE FROM audit;"
( printf 'BEGIN IMMEDIATE;\n'; sleep 1; printf 'COMMIT;\n' ) | sqlite3 "$DB" &
HOLDER_PID=$!
# Give the holder a moment to acquire the write lock before the hook runs.
sleep 0.2
run_hook "/roundtable under contention"
wait "$HOLDER_PID" 2>/dev/null || true
COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='roundtable_slash_invoked';")
assert_eq "1" "$COUNT" "audit row inserted after waiting out the concurrent write lock"

summarize
