#!/usr/bin/env bash
# Tests for the skill fallback scripts' DB resolution (GH 1553):
# skills/tmb_recovery/scripts/bro-sqlite-readonly.sh and
# skills/tmb_review/scripts/validation-record-fallback.sh resolve the trajectory
# DB through tmb_db_path (CLAUDE_PROJECT_DIR), never from the cwd. Each runs
# from / and from a worktree path whose ancestor holds a decoy DB; both must
# read and write the project's DB and create no .claude dir in the cwd.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/lib/assert.sh
. "$HERE/../../lib/assert.sh"
# shellcheck source=tests/lib/tmpdir-cleanup.sh
. "$HERE/../../lib/tmpdir-cleanup.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
READONLY="$PLUGIN_ROOT/skills/tmb_recovery/scripts/bro-sqlite-readonly.sh"
VALIDATION="$PLUGIN_ROOT/skills/tmb_review/scripts/validation-record-fallback.sh"

TMP=$(mktemp -d)
trap 'tmpdir_cleanup "$TMP"' EXIT

seed_db() {
  local db="$1" sentinel="$2"
  mkdir -p "$(dirname "$db")"
  sqlite3 "$db" "
    PRAGMA journal_mode=DELETE;
    CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE issues (id INTEGER PRIMARY KEY, objective TEXT, status TEXT);
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, issue_id INTEGER, branch_id TEXT, status TEXT);
    CREATE TABLE validation_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER, attempt_n INTEGER, agent TEXT,
      verdict TEXT, feedback TEXT, mcp_available INTEGER, subagent_session_id TEXT, created_at TEXT);
    INSERT INTO plugin_config VALUES ('sentinel', '\"$sentinel\"', '2026-01-01T00:00:00Z');" >/dev/null
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

test_case "no .claude dir appears in either cwd"
if [ -e /.claude ]; then _fail "/.claude exists"; else _pass; fi
if [ -e "$WT/.claude" ]; then _fail "$WT/.claude created"; else _pass; fi

test_case "nothing names a DB: db-not-found with the hint, nothing created in the cwd"
out=$( (cd "$WT" && env -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR TMB_TEST_RUN_ID=skill-fallback-db bash "$READONLY" --dry-run 2>&1) || true)
assert_contains "$out" '"error":"db-not-found","path":"unresolved"' "readonly: unresolved, not the cwd's DB"
assert_contains "$out" "Set CLAUDE_PROJECT_DIR" "readonly: hint"
out=$( (cd "$WT" && env -u TRAJECTORY_DB_PATH -u CLAUDE_PLUGIN_ROOT -u CLAUDE_PROJECT_DIR TMB_TEST_RUN_ID=skill-fallback-db bash "$VALIDATION" 7 9 fail "no" sess-x 2>&1) || true)
assert_contains "$out" '"error":"db-not-found","path":"unresolved"' "validation: unresolved, not the cwd's DB"
if [ -e "$WT/.claude" ]; then _fail "$WT/.claude created"; else _pass; fi

summarize
