#!/usr/bin/env bash
# Tests for the skill fallback scripts' DB resolution (GH 1553):
# skills/tmb_recovery/scripts/bro-sqlite-readonly.sh and
# skills/tmb_review/scripts/validation-record-fallback.sh resolve the trajectory
# DB through tmb_db_path (CLAUDE_PROJECT_DIR), never from the cwd. Each runs
# from / and from a worktree path whose ancestor holds a decoy DB; both must
# read and write the project's DB and create no .claude dir in the cwd.
# validation-record-fallback.sh also records review_findings as
# validation_record does (GH 1783): fail requires them, pass refuses them.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/lib/assert.sh
. "$HERE/../../lib/assert.sh"
# shellcheck source=tests/lib/tmpdir-cleanup.sh
. "$HERE/../../lib/tmpdir-cleanup.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
READONLY="$PLUGIN_ROOT/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh"
VALIDATION="$PLUGIN_ROOT/skills/tmb_review/scripts/validation-record-fallback.sh"

TMP=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-skill-fallback-db.XXXXXX")
trap 'tmpdir_cleanup "$TMP"' EXIT

# shellcheck source=tests/l3-integration/hooks/fixtures/migrated-db.sh
. "$HERE/fixtures/migrated-db.sh"

seed_db() {
  local db="$1" sentinel="$2"
  migrated_db "$db"
  sqlite3 "$db" "
    PRAGMA journal_mode=DELETE;
    INSERT INTO issues (id, objective, status, created_at, updated_at)
      VALUES (1, 'fallback db', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO tasks (id, issue_id, branch_id, description, created_at, updated_at)
      VALUES (7, 1, 'fix/fallback-db', 'validated task', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT OR REPLACE INTO plugin_config (key, value_json) VALUES ('sentinel', '\"$sentinel\"');" >/dev/null
}

PROJECT="$TMP/project"
PROJECT_DB="$PROJECT/.claude/tmb/trajectory.db"
seed_db "$PROJECT_DB" project-db

DECOY="$TMP/decoy"
seed_db "$DECOY/.claude/tmb/trajectory.db" decoy-db
WT="$DECOY/.claude/worktrees/wt"
mkdir -p "$WT"

run_in() {
  local cwd="$1"; shift
  (cd "$cwd" && env -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT CLAUDE_PROJECT_DIR="$PROJECT" "$@" 2>&1) || true
}

attempt=0
for cwd in / "$WT"; do
  test_case "bro-sqlite-readonly.sh from $cwd reads the project's DB"
  out=$(run_in "$cwd" bash "$READONLY" config_get '{"key":"sentinel"}')
  assert_contains "$out" "project-db" "sentinel row read"
  assert_not_contains "$out" "decoy-db" "decoy DB never read"
  out=$(run_in "$cwd" bash "$READONLY" --dry-run)
  assert_contains "$out" "\"db_path\":\"$PROJECT_DB\"" "dry-run names the project's DB"

  test_case "validation-record-fallback.sh from $cwd writes the project's DB"
  attempt=$((attempt + 1))
  out=$(run_in "$cwd" bash "$VALIDATION" 7 "$attempt" pass "ok" "sess-$attempt")
  assert_contains "$out" '"ok":true' "insert reported"
  assert_eq "1" "$(sqlite3 "$PROJECT_DB" "SELECT COUNT(*) FROM validation_attempts WHERE attempt_n = $attempt AND mcp_available = 0;")" "row landed in the project's DB"
  assert_eq "0" "$(sqlite3 "$DECOY/.claude/tmb/trajectory.db" "SELECT COUNT(*) FROM validation_attempts;")" "decoy DB untouched"
done

test_case "validation-record-fallback.sh waits out a concurrent writer; a quote in feedback survives"
printf 'BEGIN IMMEDIATE;\n.shell sleep 0.6\nCOMMIT;\n' | sqlite3 "$PROJECT_DB" >/dev/null 2>&1 &
holder=$!
sleep 0.2
out=$(run_in / bash "$VALIDATION" 7 50 fail "it's not done" sess-lock '[{"criterion_id":"SC1","probe_cmd":"test -f it'"'"'s","expected":"e","observed":"o"}]')
wait "$holder"
assert_contains "$out" '"ok":true' "insert waited for the writer's lock"
assert_contains "$out" '"findings":["F7-1"]' "finding id reported"
assert_eq "it's not done" "$(sqlite3 "$PROJECT_DB" "SELECT feedback FROM validation_attempts WHERE attempt_n = 50;")" "feedback stored verbatim"
assert_eq "test -f it's" "$(sqlite3 "$PROJECT_DB" "SELECT probe_cmd FROM review_findings WHERE id = 'F7-1';")" "a quote in probe_cmd survives"

rows() {
  sqlite3 "$PROJECT_DB" "SELECT (SELECT COUNT(*) FROM validation_attempts) || '/' || (SELECT COUNT(*) FROM review_findings);"
}

test_case "fail without findings, or with [], is findings_required and writes nothing"
before=$(rows)
out=$(run_in / bash "$VALIDATION" 7 60 fail "broken" sess-60)
assert_contains "$out" '"error":"findings_required"' "omitted findings refused"
out=$(run_in / bash "$VALIDATION" 7 60 fail "broken" sess-60 '[]')
assert_contains "$out" '"error":"findings_required"' "empty findings refused"
assert_eq "$before" "$(rows)" "no attempt or finding row written"

test_case "pass with findings is findings_refused; pass with none or [] records as before"
before=$(rows)
out=$(run_in / bash "$VALIDATION" 7 61 pass "fine" sess-61 '[{"probe_cmd":"true","expected":"e","observed":"o"}]')
assert_contains "$out" '"error":"findings_refused"' "pass with a finding refused"
assert_eq "$before" "$(rows)" "nothing written"
out=$(run_in / bash "$VALIDATION" 7 62 pass "fine" sess-62 '[]')
assert_contains "$out" '"ok":true' "pass with [] recorded"
assert_contains "$out" '"findings":[]' "no finding ids"
assert_eq "1|0" "$(sqlite3 "$PROJECT_DB" "SELECT COUNT(*), (SELECT COUNT(*) FROM review_findings WHERE attempt_n = 62) FROM validation_attempts WHERE attempt_n = 62 AND verdict = 'pass' AND mcp_available = 0;")" "pass row, no findings"

test_case "fail with findings writes one open row per entry, trimmed, ids continuing after the task's highest"
out=$(run_in / bash "$VALIDATION" 7 70 fail "two defects" sess-70 '[{"probe_cmd":"  bash -c \"exit 1\"\n","expected":" exits 0 ","observed":"\texits 1 "},{"criterion_id":null,"probe_cmd":"false","expected":"e2","observed":"o2"},{"criterion_id":" SC3 ","probe_cmd":"false","expected":"e3","observed":"o3"}]')
assert_contains "$out" '"findings":["F7-2","F7-3","F7-4"]' "ids continue after F7-1"
assert_eq "1" "$(sqlite3 "$PROJECT_DB" "SELECT COUNT(*) FROM validation_attempts WHERE attempt_n = 70 AND verdict = 'fail' AND mcp_available = 0;")" "attempt row with mcp_available = 0"
assert_eq 'F7-2|70|<null>|bash -c "exit 1"|exits 0|exits 1|open
F7-3|70|<null>|false|e2|o2|open
F7-4|70|SC3|false|e3|o3|open' "$(sqlite3 "$PROJECT_DB" "SELECT id, attempt_n, COALESCE(criterion_id, '<null>'), probe_cmd, expected, observed, status FROM review_findings WHERE attempt_n = 70 ORDER BY id;")" "rows open, criterion_id NULL when absent or null, text trimmed"

test_case "re-recording an attempt replaces only its open rows, never reusing an id"
sqlite3 "$PROJECT_DB" "UPDATE review_findings SET status = 'fixed', resolved_at = '2026-01-02T00:00:00.000Z' WHERE id = 'F7-4';"
out=$(run_in / bash "$VALIDATION" 7 70 fail "one defect left" sess-70b '[{"probe_cmd":"false","expected":"e5","observed":"o5"}]')
assert_contains "$out" '"findings":["F7-5"]' "new id after the deleted ones"
assert_eq "F7-1 F7-4 F7-5" "$(sqlite3 "$PROJECT_DB" "SELECT group_concat(id, ' ') FROM (SELECT id FROM review_findings ORDER BY id);")" "open rows of attempt 70 replaced; attempt 50 and the fixed row kept"
assert_eq "1|one defect left|sess-70b" "$(sqlite3 "$PROJECT_DB" "SELECT COUNT(*), feedback, subagent_session_id FROM validation_attempts WHERE attempt_n = 70;")" "attempt row replaced in place"

test_case "a malformed findings array is invalid_findings and writes nothing"
before=$(rows)
for bad in 'not json' '{"probe_cmd":"false"}' '["false"]' \
  '[{"probe_cmd":"","expected":"e","observed":"o"}]' \
  '[{"probe_cmd":"false","expected":"  ","observed":"o"}]' \
  '[{"probe_cmd":"false","expected":"e"}]' \
  '[{"probe_cmd":"false","expected":"e","observed":"o","status":"fixed"}]' \
  '[{"criterion_id":"","probe_cmd":"false","expected":"e","observed":"o"}]' \
  '[{"probe_cmd":"false","expected":"e","observed":"o"},{"probe_cmd":"false","expected":"e","observed":7}]'; do
  out=$(run_in / bash "$VALIDATION" 7 80 fail "bad" sess-80 "$bad")
  assert_contains "$out" '"error":"invalid_findings"' "refused: $bad"
done
assert_eq "$before" "$(rows)" "no attempt or finding row written"

test_case "no .claude dir appears in either cwd"
if [ -e /.claude ]; then _fail "/.claude exists"; else _pass; fi
if [ -e "$WT/.claude" ]; then _fail "$WT/.claude created"; else _pass; fi

test_case "nothing names a DB: db-not-found with the hint, nothing created in the cwd"
out=$( (cd "$WT" && env -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR TMB_TEST_RUN_ID=skill-fallback-db bash "$READONLY" --dry-run 2>&1) || true)
assert_contains "$out" '"error":"db-not-found","path":"unresolved"' "readonly: unresolved, not the cwd's DB"
assert_contains "$out" "Set CLAUDE_PROJECT_DIR" "readonly: hint"
out=$( (cd "$WT" && env -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR TMB_TEST_RUN_ID=skill-fallback-db bash "$VALIDATION" 7 9 fail "no" sess-x '[{"probe_cmd":"false","expected":"e","observed":"o"}]' 2>&1) || true)
assert_contains "$out" '"error":"db-not-found","path":"unresolved"' "validation: unresolved, not the cwd's DB"
if [ -e "$WT/.claude" ]; then _fail "$WT/.claude created"; else _pass; fi

summarize
