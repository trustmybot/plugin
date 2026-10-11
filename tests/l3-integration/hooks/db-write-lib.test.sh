#!/usr/bin/env bash
# Tests for scripts/hooks/lib/db-write.sh — the shared hook write library.
# Covers: transaction rollback, FK enforcement, busy-retry through a held write
# lock, from_node validation in tmb_audit_append, tmb_gate_read's __ERR__
# sentinel, and the tmb_now_iso shape.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/hooks/lib/db-write.sh"
SCHEMA="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"

TMPDIR_FIXTURE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_FIXTURE"' EXIT
DB="$TMPDIR_FIXTURE/trajectory.db"
sqlite3 "$DB" < "$SCHEMA" >/dev/null

# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$LIB"

count() { sqlite3 "$DB" "$1"; }

test_case "tmb_now_iso prints a 24-char UTC ms-ISO timestamp"
NOW=$(tmb_now_iso)
assert_eq "24" "${#NOW}" "tmb_now_iso length"
case "$NOW" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].000Z) _pass ;;
  *) _fail "tmb_now_iso shape: got <$NOW>" ;;
esac

test_case "tmb_db_write commits a valid transaction"
tmb_db_write "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_ok', '1');" 2>/dev/null && RC=0 || RC=$?
assert_eq "0" "$RC" "exit code on success"
assert_eq "1" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_ok';")" "row committed"

test_case "tmb_db_write rolls back when a later statement violates a CHECK"
ERR=$(tmb_db_write "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_rollback', '1');
INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, mcp_available, created_at)
VALUES (1, 1, 'pr-reviewer', 'not-a-verdict', '', 0, '$(tmb_now_iso)');" 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "CHECK violation should return non-zero"
assert_eq "0" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_rollback';")" "first statement rolled back"
assert_contains "$ERR" "tmb_db_write: " "one stderr line names the library"
assert_eq "1" "$(printf '%s\n' "$ERR" | grep -c .)" "exactly one stderr line"

test_case "tmb_db_write enforces foreign keys (audit row for a missing issue)"
ERR=$(tmb_db_write "$DB" "INSERT INTO audit (issue_id, from_node, event_type, summary, content_json, created_at)
VALUES (424242, 'hook:x', 'fk_probe', 'x', '{}', '$(tmb_now_iso)');" 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "FK violation should return non-zero"
assert_contains "$ERR" "FOREIGN KEY" "stderr names the FK failure"
assert_eq "0" "$(count "SELECT COUNT(*) FROM audit WHERE event_type='fk_probe';")" "no orphan audit row"

test_case "tmb_db_write on a missing DB file fails visibly without creating it"
ERR=$(tmb_db_write "$TMPDIR_FIXTURE/missing.db" "INSERT INTO plugin_config (key, value_json) VALUES ('x', '1');" 2>&1 >/dev/null) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && _pass || _fail "missing DB should return non-zero"
assert_contains "$ERR" "database not found" "stderr names the missing DB"
[ ! -e "$TMPDIR_FIXTURE/missing.db" ] && _pass || _fail "missing DB must not be created"

test_case "tmb_db_write retries through a held write lock"
( printf 'BEGIN IMMEDIATE;\nINSERT INTO plugin_config (key, value_json) VALUES (%s, %s);\n' "'dbw_holder'" "'1'"
  sleep 1
  printf 'COMMIT;\n' ) | sqlite3 "$DB" &
HOLDER=$!
sleep 0.2
tmb_db_write "$DB" "INSERT INTO plugin_config (key, value_json) VALUES ('dbw_busy', '1');" 2>/dev/null && RC=0 || RC=$?
wait "$HOLDER"
assert_eq "0" "$RC" "write lands once the lock is released"
assert_eq "1" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_busy';")" "busy-retried row present"
assert_eq "1" "$(count "SELECT COUNT(*) FROM plugin_config WHERE key='dbw_holder';")" "lock holder's row present"

test_case "tmb_audit_append rejects an agent-impersonating from_node"
ERR=$(tmb_audit_append "$DB" -1 '' bro probe_event "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "from_node outside the allowed set exits 2"
assert_contains "$ERR" "invalid from_node" "stderr names the invalid from_node"
ERR=$(tmb_audit_append "$DB" -1 '' "hook:Bad_Name" probe_event "x" '{}' 2>&1 >/dev/null) && RC=0 || RC=$?
assert_eq "2" "$RC" "malformed hook:<name> exits 2"
assert_eq "0" "$(count "SELECT COUNT(*) FROM audit WHERE event_type='probe_event';")" "rejected rows not written"

test_case "tmb_audit_append accepts hook:<name> and quotes every value"
tmb_audit_append "$DB" -1 '' "hook:x" probe_ok "it's quoted" '{"note":"it'"'"'s"}' 2>/dev/null && RC=0 || RC=$?
assert_eq "0" "$RC" "hook:x accepted"
ROW=$(count "SELECT from_node || '|' || summary || '|' || json_extract(content_json, '\$.note') || '|' || COALESCE(branch_id, 'NULL') || '|' || length(created_at) FROM audit WHERE event_type='probe_ok';")
assert_eq "hook:x|it's quoted|it's|NULL|24" "$ROW" "row values round-trip"

test_case "tmb_audit_append writes repo from the parent issue"
sqlite3 "$DB" "INSERT INTO repos (name, path) VALUES ('dbw-repo', '/tmp/dbw-repo');
INSERT INTO issues (id, objective, description, status, repo, created_at, updated_at)
VALUES (77, 'o', 'd', 'open', 'dbw-repo', '$(tmb_now_iso)', '$(tmb_now_iso)');" >/dev/null
tmb_audit_append "$DB" 77 'feat/x' "hook:x" probe_repo "s" '{}' 2>/dev/null
assert_eq "dbw-repo|feat/x" "$(count "SELECT repo || '|' || branch_id FROM audit WHERE event_type='probe_repo';")" "repo + branch_id"

test_case "tmb_gate_read prints __ERR__ on a missing DB file"
assert_eq "__ERR__" "$(tmb_gate_read "$TMPDIR_FIXTURE/nope.db" "SELECT 1;")" "missing DB"

test_case "tmb_gate_read prints __ERR__ on a sqlite3 error"
assert_eq "__ERR__" "$(tmb_gate_read "$DB" "SELECT * FROM no_such_table;")" "query error"

test_case "tmb_gate_read distinguishes no rows from an error"
assert_eq "" "$(tmb_gate_read "$DB" "SELECT key FROM plugin_config WHERE key='absent';")" "empty result"
assert_eq "1" "$(tmb_gate_read "$DB" "SELECT value_json FROM plugin_config WHERE key='dbw_ok';")" "row result"

summarize
