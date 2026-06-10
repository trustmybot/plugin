#!/usr/bin/env bash
# L3 tests for scripts/hooks/roundtable-cleanup-postcheck.sh
#
# Verifies: (1) correct state column (not status) is queried, (2) a fully-closed
# roundtable with all capture surfaces produces no advisory, (3) a roundtable
# missing capture surfaces does produce an advisory.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/roundtable-cleanup-postcheck.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

command -v sqlite3 >/dev/null 2>&1 || { echo "SKIP: sqlite3 unavailable"; exit 0; }
command -v jq     >/dev/null 2>&1 || { echo "SKIP: jq unavailable"; exit 0; }

TMPDIR_RC=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RC"' EXIT

DB="$TMPDIR_RC/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$SCHEMA" >/dev/null

# Seed a base issue and roundtable
sqlite3 "$DB" "
  INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
  INSERT INTO roundtables (id, issue_id, topic, state, outcome, created_at)
    VALUES (1, 1, 'test topic', 'closed', 'proceed', datetime('now'));
  INSERT INTO discussions (issue_id, author, kind, body, created_at)
    VALUES (1, 'bro', 'analysis', 'analysis body', datetime('now'));
  INSERT INTO discussions (issue_id, author, kind, body, created_at)
    VALUES (1, 'bro', 'decision', 'decision body', datetime('now'));
" >/dev/null
# roundtable_votes uses participant not voter in the real schema
sqlite3 "$DB" "
  INSERT INTO roundtable_votes (roundtable_id, participant, vote, rationale, created_at)
    VALUES (1, 'agent1', 'yes', 'ok', datetime('now'));
  INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
    VALUES (1, NULL, 'system', 'roundtable_summary', 'summary', '{}', datetime('now'));
" >/dev/null

run_hook() {
  local rt_id="$1"
  echo "{\"tool_name\":\"mcp__plugin_tmb_trajectory-server__roundtable_close\",\"tool_input\":{\"roundtable_id\":$rt_id}}" \
    | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true
}

# ── fully-closed roundtable: no advisory ─────────────────────────────────────

test_case "fully-closed roundtable with all capture surfaces: no advisory output"
out=$(run_hook 1)
assert_not_contains "$out" "additionalContext" "no advisory when all surfaces present"
assert_not_contains "$out" "roundtable.status=closed" "status=closed must NOT appear (column is state)"

# ── missing capture surfaces: advisory fires ─────────────────────────────────

test_case "roundtable with state=collecting (not closed) triggers advisory"
sqlite3 "$DB" "UPDATE roundtables SET state='collecting', outcome='' WHERE id=1;" >/dev/null
out=$(run_hook 1)
assert_contains "$out" "additionalContext" "advisory must fire when state not closed"
assert_contains "$out" "roundtable.status=closed" "missing item text present"
assert_contains "$out" "roundtable.outcome" "missing outcome reported"

test_case "state column comparison (not status) — closed roundtable not falsely flagged"
sqlite3 "$DB" "UPDATE roundtables SET state='closed', outcome='proceed' WHERE id=1;" >/dev/null
out=$(run_hook 1)
assert_not_contains "$out" "roundtable.status=closed" "closed state must not appear in MISSING list"

# ── wrong tool name: silent no-op ────────────────────────────────────────────

test_case "wrong tool name is silent no-op"
out=$(echo '{"tool_name":"some_other_tool","tool_input":{"roundtable_id":1}}' \
  | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "silent on wrong tool"

summarize
