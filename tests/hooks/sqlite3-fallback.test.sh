#!/usr/bin/env bash
# Tests for scripts/lib/sqlite3-fallback.sh
# Covers: happy path writes + audit rows, role rejection, missing DB,
# SQL injection guard (single-quote round-trip), and file_registry_update_summary.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
LIB="$PLUGIN_ROOT/scripts/lib/sqlite3-fallback.sh"

TMPDIR_FIXTURE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_FIXTURE"' EXIT
DB="$TMPDIR_FIXTURE/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

sqlite3 "$DB" "
PRAGMA foreign_keys = OFF;
CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  objective TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  pre_commit_hash TEXT NOT NULL DEFAULT '',
  post_commit_hash TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  current_task_id INTEGER,
  labels TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  closed_at TEXT
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  issue_id INTEGER NOT NULL DEFAULT 1,
  branch_id TEXT NOT NULL DEFAULT '',
  parent_branch_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  tools_required TEXT NOT NULL DEFAULT '[]',
  skills_required TEXT NOT NULL DEFAULT '[]',
  success_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  spec_body TEXT NOT NULL DEFAULT '',
  commit_sha TEXT,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  completed_at TEXT
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL DEFAULT 0,
  branch_id TEXT,
  from_node TEXT NOT NULL DEFAULT 'executor',
  kind TEXT NOT NULL DEFAULT 'event',
  event_type TEXT,
  summary TEXT,
  content_json TEXT NOT NULL DEFAULT '{}',
  round INTEGER NOT NULL DEFAULT 0,
  tool_name TEXT,
  tool_args TEXT NOT NULL DEFAULT '{}',
  output TEXT NOT NULL DEFAULT '',
  output_chars INTEGER NOT NULL DEFAULT 0,
  is_truncated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE validation_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  attempt_n INTEGER NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,
  feedback TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(task_id, attempt_n)
);
CREATE TABLE discussions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE file_registry (
  path TEXT PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'unknown',
  language TEXT,
  size_bytes INTEGER,
  last_commit_sha TEXT,
  last_change_type TEXT,
  last_change_at TEXT,
  imports_json TEXT NOT NULL DEFAULT '[]',
  exports_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_md5 TEXT,
  summary TEXT,
  summary_updated_at TEXT
);
INSERT INTO issues (id, created_at, updated_at) VALUES (1, datetime('now'), datetime('now'));
INSERT INTO tasks (id, created_at, updated_at) VALUES (42, datetime('now'), datetime('now'));
"

call_lib() {
  bash -c ". '$LIB'; $*" 2>&1
}

call_lib_stderr() {
  bash -c ". '$LIB'; $*" 2>/tmp/tmb_test_stderr; cat /tmp/tmb_test_stderr
}

audit_count_for() {
  local tool="$1"
  sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='mcp_unavailable_fallback_invoked' AND summary LIKE '%$tool%';"
}

# ---------------------------------------------------------------------------
# tmb_fallback_validation_record
# ---------------------------------------------------------------------------

test_case "validation_record happy path: row inserted"
call_lib "tmb_fallback_validation_record 42 1 pr-reviewer pass 'looks good'" >/dev/null
row=$(sqlite3 "$DB" "SELECT verdict, feedback FROM validation_attempts WHERE task_id=42 AND attempt_n=1;")
assert_eq "pass|looks good" "$row" "validation_attempts row"

test_case "validation_record happy path: audit row written"
count=$(audit_count_for "validation_record")
assert_eq "1" "$count" "audit rows after validation_record"

test_case "validation_record role rejection: swe is not allowed"
out=$(call_lib "tmb_fallback_validation_record 42 2 swe pass 'nope'" 2>&1 || true)
assert_contains "$out" "not allowed for 'validation_record'" "role rejection message"

test_case "validation_record role rejection: no DB write on rejected role"
count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM validation_attempts WHERE attempt_n=2;")
assert_eq "0" "$count" "no row written on role rejection"

test_case "validation_record SQL injection: single-quote in feedback round-trips"
call_lib "tmb_fallback_validation_record 42 3 pr-reviewer pass \"it's fine, don't panic\"" >/dev/null
feedback=$(sqlite3 "$DB" "SELECT feedback FROM validation_attempts WHERE task_id=42 AND attempt_n=3;")
assert_eq "it's fine, don't panic" "$feedback" "single-quote round-trip"

# ---------------------------------------------------------------------------
# tmb_fallback_task_update_status
# ---------------------------------------------------------------------------

test_case "task_update_status happy path: status updated"
call_lib "tmb_fallback_task_update_status 42 completed swe abc123" >/dev/null
status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "completed" "$status" "task status"

test_case "task_update_status happy path: commit_sha written"
sha=$(sqlite3 "$DB" "SELECT commit_sha FROM tasks WHERE id=42;")
assert_eq "abc123" "$sha" "commit_sha"

test_case "task_update_status happy path: audit row written"
count=$(audit_count_for "task_update_status")
assert_eq "1" "$count" "audit row after task_update_status"

test_case "task_update_status role rejection: architect not allowed"
out=$(call_lib "tmb_fallback_task_update_status 42 closed architect" 2>&1 || true)
assert_contains "$out" "not allowed for 'task_update_status'" "role rejection message"

test_case "task_update_status without commit_sha: status updated, sha unchanged"
call_lib "tmb_fallback_task_update_status 42 running swe" >/dev/null
status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id=42;")
assert_eq "running" "$status" "status without sha arg"

# ---------------------------------------------------------------------------
# tmb_fallback_discussion_append
# ---------------------------------------------------------------------------

test_case "discussion_append happy path: row inserted"
call_lib "tmb_fallback_discussion_append 1 bro note 'planning complete' bro" >/dev/null
body=$(sqlite3 "$DB" "SELECT body FROM discussions WHERE issue_id=1 LIMIT 1;")
assert_eq "planning complete" "$body" "discussion body"

test_case "discussion_append happy path: audit row written"
count=$(audit_count_for "discussion_append")
assert_eq "1" "$count" "audit row after discussion_append"

test_case "discussion_append role rejection: unknown agent blocked"
out=$(call_lib "tmb_fallback_discussion_append 1 ghost note 'haxor' ghost" 2>&1 || true)
assert_contains "$out" "not allowed for 'discussion_append'" "role rejection"

test_case "discussion_append SQL injection: single-quote in body round-trips"
call_lib "tmb_fallback_discussion_append 1 bro note \"it's bro's note\" bro" >/dev/null
body=$(sqlite3 "$DB" "SELECT body FROM discussions WHERE issue_id=1 ORDER BY id DESC LIMIT 1;")
assert_eq "it's bro's note" "$body" "single-quote in body"

# ---------------------------------------------------------------------------
# tmb_fallback_audit_log
# ---------------------------------------------------------------------------

test_case "audit_log happy path: row inserted"
call_lib "tmb_fallback_audit_log 1 'fix/test' bro planning_complete 'done' '{}' bro" >/dev/null
count=$(sqlite3 "$DB" "SELECT COUNT(*) FROM audit WHERE event_type='planning_complete' AND kind='event';")
assert_eq "1" "$count" "audit_log row"

test_case "audit_log happy path: audit self-row written"
count=$(audit_count_for "audit_log")
assert_eq "1" "$count" "audit self-row after audit_log"

test_case "audit_log role rejection: unknown agent blocked"
out=$(call_lib "tmb_fallback_audit_log 1 '' ghost planning_complete 'x' '{}' ghost" 2>&1 || true)
assert_contains "$out" "not allowed for 'audit_log'" "role rejection"

# ---------------------------------------------------------------------------
# tmb_fallback_issue_close
# ---------------------------------------------------------------------------

test_case "issue_close happy path: status set to closed"
call_lib "tmb_fallback_issue_close 1 bro" >/dev/null
status=$(sqlite3 "$DB" "SELECT status FROM issues WHERE id=1;")
assert_eq "closed" "$status" "issue status closed"

test_case "issue_close happy path: closed_at populated"
closed_at=$(sqlite3 "$DB" "SELECT closed_at FROM issues WHERE id=1;")
[ -n "$closed_at" ] && _pass || _fail "closed_at should be non-empty, got empty"

test_case "issue_close happy path: audit row written"
count=$(audit_count_for "issue_close")
assert_eq "1" "$count" "audit row after issue_close"

test_case "issue_close with post_git_sha: post_commit_hash written"
sqlite3 "$DB" "UPDATE issues SET status='open', closed_at=NULL WHERE id=1;"
call_lib "tmb_fallback_issue_close 1 bro deadbeef" >/dev/null
sha=$(sqlite3 "$DB" "SELECT post_commit_hash FROM issues WHERE id=1;")
assert_eq "deadbeef" "$sha" "post_commit_hash"

test_case "issue_close role rejection: swe not allowed"
out=$(call_lib "tmb_fallback_issue_close 1 swe" 2>&1 || true)
assert_contains "$out" "not allowed for 'issue_close'" "role rejection"

# ---------------------------------------------------------------------------
# tmb_fallback_file_registry_update_summary
# ---------------------------------------------------------------------------

DUMMY_FILE="$TMPDIR_FIXTURE/dummy.sh"
printf '#!/usr/bin/env bash\necho hello\n' > "$DUMMY_FILE"

test_case "file_registry_update_summary happy path: row upserted"
call_lib "tmb_fallback_file_registry_update_summary bro '$DUMMY_FILE' 'a dummy script'" >/dev/null
summary=$(sqlite3 "$DB" "SELECT summary FROM file_registry WHERE path='$DUMMY_FILE';")
assert_eq "a dummy script" "$summary" "file_registry summary"

test_case "file_registry_update_summary happy path: content_md5 written"
md5=$(sqlite3 "$DB" "SELECT content_md5 FROM file_registry WHERE path='$DUMMY_FILE';")
[ -n "$md5" ] && _pass || _fail "content_md5 should be non-empty, got empty"

test_case "file_registry_update_summary happy path: audit row written"
count=$(audit_count_for "file_registry_update_summaries")
assert_eq "1" "$count" "audit row after file_registry_update_summary"

test_case "file_registry_update_summary role rejection: swe not allowed"
out=$(call_lib "tmb_fallback_file_registry_update_summary swe '$DUMMY_FILE' 'test'" 2>&1 || true)
assert_contains "$out" "not allowed for 'file_registry_update_summaries'" "role rejection"

test_case "file_registry_update_summary: missing file returns error"
out=$(call_lib "tmb_fallback_file_registry_update_summary bro '/no/such/file.sh' 'x'" 2>&1 || true)
assert_contains "$out" "not on disk" "missing file error"

# ---------------------------------------------------------------------------
# Missing DB guard
# ---------------------------------------------------------------------------

test_case "missing DB: validation_record returns clear error"
out=$(TRAJECTORY_DB_PATH="$TMPDIR_FIXTURE/nonexistent.db" bash -c ". '$LIB'; tmb_fallback_validation_record 1 1 pr-reviewer pass ok" 2>&1 || true)
assert_contains "$out" "no DB found" "missing DB error"

summarize
