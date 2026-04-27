#!/usr/bin/env bash
# Tests for scripts/hooks/require-summaries-before-task-close.sh.
# Hook contract: PreToolUse on task_update_status. Block when bro tries to
# close a task and file_registry has missing/stale summaries for the
# commit's touched paths. Allow when summaries are fresh, when not bro,
# when not status='closed', when bypass env set.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/require-summaries-before-task-close.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

REPO="$TMPDIR/repo"
git init -q -b main "$REPO"
cd "$REPO"
git config user.email t@t.io && git config user.name t
mkdir -p src
echo "init" > README.md
git add . && git commit -qm init

DB="$REPO/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT, status TEXT, commit_sha TEXT, created_at TEXT);
  CREATE TABLE file_registry (path TEXT PRIMARY KEY, content_md5 TEXT, summary TEXT, summary_updated_at TEXT);
"
export TRAJECTORY_DB_PATH="$DB"

# Create a commit on a feature branch with two files.
git checkout -q -b fix/foo
echo 'a' > src/a.py
echo 'b' > src/b.py
git add . && git commit -qm "feat: add a + b"
COMMIT_SHA=$(git rev-parse HEAD)

sqlite3 "$DB" "INSERT INTO tasks (id, branch_id, status, commit_sha, created_at)
  VALUES (1, 'fix/foo', 'completed', '$COMMIT_SHA', datetime('now', '-1 hour'));"

input() {
  local agent="$1" status="$2" task_id="$3"
  jq -n --arg agent "$agent" --arg status "$status" --argjson tid "$task_id" '{
    tool_name: "mcp__plugin_tmb_trajectory-server__task_update_status",
    tool_input: { agent: $agent, status: $status, task_id: $tid }
  }'
}

run_hook() { echo "$1" | bash "$HOOK" 2>&1 || true; }

test_case "wrong tool name: silent pass"
out=$(echo '{"tool_name":"Bash","tool_input":{}}' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "silent on non-matching tool"

test_case "agent != bro: silent pass"
out=$(run_hook "$(input 'swe' 'closed' 1)")
assert_eq "" "$out" "silent for swe caller"

test_case "status != closed: silent pass"
out=$(run_hook "$(input 'bro' 'completed' 1)")
assert_eq "" "$out" "silent for non-closed status"

test_case "bro closing with NO file_registry rows for touched paths: BLOCK"
out=$(run_hook "$(input 'bro' 'closed' 1)")
assert_contains "$out" '"permissionDecision":"deny"' "deny on missing rows"
assert_contains "$out" 'src/a.py' "reason names a.py"
assert_contains "$out" 'src/b.py' "reason names b.py"
assert_contains "$out" 'no file_registry row' "reason categorizes"

test_case "one path has fresh summary, other doesn't: BLOCK (need all)"
sqlite3 "$DB" "INSERT INTO file_registry (path, summary, summary_updated_at) VALUES ('src/a.py', 'fresh', datetime('now'));"
out=$(run_hook "$(input 'bro' 'closed' 1)")
assert_contains "$out" '"permissionDecision":"deny"' "still deny"
assert_contains "$out" 'src/b.py' "names the unfresh one"

test_case "stale summary (older than task created_at): BLOCK"
sqlite3 "$DB" "INSERT INTO file_registry (path, summary, summary_updated_at) VALUES ('src/b.py', 'old', datetime('now', '-2 hour'));"
out=$(run_hook "$(input 'bro' 'closed' 1)")
assert_contains "$out" '"permissionDecision":"deny"' "deny on stale"
assert_contains "$out" 'stale-summary' "reason flags stale"

test_case "all touched paths have fresh summaries: PASS"
sqlite3 "$DB" "UPDATE file_registry SET summary='fresh-b', summary_updated_at=datetime('now') WHERE path='src/b.py';"
out=$(run_hook "$(input 'bro' 'closed' 1)")
assert_eq "" "$out" "allow when all fresh"

test_case "TMB_ALLOW_CLOSE_WITHOUT_SUMMARIES bypass: PASS even with missing"
sqlite3 "$DB" "DELETE FROM file_registry;"
out=$(echo "$(input 'bro' 'closed' 1)" | env TMB_ALLOW_CLOSE_WITHOUT_SUMMARIES=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "env bypass works"

test_case "no DB (not a TMB project): silent pass"
unset TRAJECTORY_DB_PATH
mv "$DB" "$DB.bak"
out=$(run_hook "$(input 'bro' 'closed' 1)")
mv "$DB.bak" "$DB"
export TRAJECTORY_DB_PATH="$DB"
assert_eq "" "$out" "no DB allow"

test_case "task has no commit_sha: silent pass (defensive)"
sqlite3 "$DB" "UPDATE tasks SET commit_sha=NULL WHERE id=1;"
out=$(run_hook "$(input 'bro' 'closed' 1)")
assert_eq "" "$out" "silent without sha"
