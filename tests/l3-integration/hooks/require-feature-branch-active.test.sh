#!/usr/bin/env bash
# Tests for scripts/hooks/require-feature-branch-active.sh
#
# Hook contract: block SWE agent spawn when the task's branch_id does not yet
# exist (bro pre-creates it; main stays on <base>). Passes through silently for non-swe agents, missing task_id,
# or missing DB. Bypass: TMB_ALLOW_BRANCH_MISMATCH=1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/require-feature-branch-active.sh"

# ----- helpers ----------------------------------------------------------

# Create a fresh temp git repo on a given branch name.
setup_repo() {
  local branch="${1:-fix/1-foo}"
  local dir
  dir=$(mktemp -d -t tmb-branch-active-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b "$branch"
    git config user.email "test@example.com"
    git config user.name  "Test"
    echo "init" > README.md
    git add README.md
    git commit -qm "init"
  )
  REPO_PATH="$dir"
}

# Apply the schema to a fresh trajectory.db inside the repo.
setup_db() {
  local repo="$1"
  local db="$repo/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$db")"
  sqlite3 "$db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  echo "$db"
}

# Insert a minimal issue + task row.
insert_task() {
  local db="$1" task_id="$2" branch_id="$3"
  sqlite3 "$db" "
    INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at)
      VALUES ($task_id, 1, '$branch_id', 'task $task_id', 'd', 'pending', '## body', datetime('now'), datetime('now'));
  " >/dev/null
}

# Build a payload for the hook.
make_payload() {
  local agent_type="$1"
  local prompt="$2"
  jq -cn --arg a "$agent_type" --arg p "$prompt" \
    '{tool_input:{subagent_type:$a,prompt:$p}}'
}

# Run the hook from inside REPO_PATH.
run_hook() {
  local payload="$1"
  local db="${2:-/nonexistent.db}"
  local extra_env="${3:-}"
  (
    cd "$REPO_PATH" || exit 1
    if [ -n "$extra_env" ]; then
      eval "export $extra_env"
    fi
    echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true
  )
}

cleanup() {
  [ -n "${REPO_PATH:-}" ] && [ -d "${REPO_PATH:-}" ] && rm -rf "$REPO_PATH"
  REPO_PATH=""
}

# ----- tests ------------------------------------------------------------

test_case "happy path: branch exists, main on base — no block"
setup_repo "dev"
git -C "$REPO_PATH" branch "fix/1-foo"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "branch exists (main stays on base) must not be blocked"
cleanup

test_case "branch missing blocks: task expects fix/1-foo but it was never created"
setup_repo "dev"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(run_hook "$payload" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "missing branch must produce deny decision"
assert_contains "$out" "fix/1-foo" "block message must name the expected branch"
assert_contains "$out" "exist" "block message must say the branch must exist"
cleanup

test_case "non-swe agent passes: architect bypasses the hook"
setup_repo "dev"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo"
payload=$(make_payload "architect" "task_id=1 You are architect.")
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "non-swe agent must not be blocked"
cleanup

test_case "no task_id in prompt passes: require-task-spec.sh handles it"
setup_repo "dev"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo"
payload=$(make_payload "swe" "You are SWE but no task_id here.")
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "missing task_id must not be blocked by this hook"
cleanup

test_case "missing DB passes: not a TMB project"
setup_repo "dev"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(run_hook "$payload" "/nonexistent/trajectory.db")
assert_not_contains "$out" '"permissionDecision":"deny"' "missing DB must not block"
cleanup

test_case "bypass env var passes: TMB_ALLOW_BRANCH_MISMATCH=1 overrides block"
setup_repo "dev"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(
  cd "$REPO_PATH" || exit 1
  echo "$payload" | TRAJECTORY_DB_PATH="$db" TMB_ALLOW_BRANCH_MISMATCH=1 bash "$HOOK" 2>&1 || true
)
assert_not_contains "$out" '"permissionDecision":"deny"' "bypass env var must suppress block even on mismatch"
cleanup

test_case "TMB workspace shape: tasks.repo=null + tmb_default_repo='plugin' + branch exists → passes"
WORKSPACE=$(mktemp -d -t tmb-workspace-XXXX)
INNER_REPO="$WORKSPACE/plugin"
mkdir -p "$INNER_REPO"
(
  cd "$INNER_REPO" || exit 1
  git init -q -b "fix/1-foo"
  git config user.email "test@example.com"
  git config user.name "Test"
  echo "init" > README.md
  git add README.md
  git commit -qm "init"
)
WS_DB="$WORKSPACE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WS_DB")"
sqlite3 "$WS_DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
sqlite3 "$WS_DB" "
  INSERT OR REPLACE INTO plugin_config (key, value_json)
    VALUES ('tmb_default_repo', '\"plugin\"');
  INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
    VALUES (10, 1, 'fix/1-foo', 'task 10', 'd', 'pending', '', NULL, datetime('now'), datetime('now'));
" >/dev/null
REPO_PATH="$INNER_REPO"
payload=$(make_payload "swe" "task_id=10 You are SWE.")
out=$(run_hook "$payload" "$WS_DB")
assert_not_contains "$out" '"permissionDecision":"deny"' "TMB workspace shape with default_repo set + branch exists must not block"
rm -rf "$WORKSPACE"
REPO_PATH=""

test_case "TMB workspace shape: tasks.repo=null + tmb_default_repo unset → blocks with clear error"
WORKSPACE=$(mktemp -d -t tmb-workspace-XXXX)
INNER_REPO="$WORKSPACE/plugin"
mkdir -p "$INNER_REPO"
(
  cd "$INNER_REPO" || exit 1
  git init -q -b "fix/1-foo"
  git config user.email "test@example.com"
  git config user.name "Test"
  echo "init" > README.md
  git add README.md
  git commit -qm "init"
)
WS_DB="$WORKSPACE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WS_DB")"
sqlite3 "$WS_DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
sqlite3 "$WS_DB" "
  INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
    VALUES (11, 1, 'fix/1-foo', 'task 11', 'd', 'pending', '', NULL, datetime('now'), datetime('now'));
" >/dev/null
REPO_PATH="$WORKSPACE"
payload=$(make_payload "swe" "task_id=11 You are SWE.")
out=$(run_hook "$payload" "$WS_DB")
assert_contains "$out" '"permissionDecision":"deny"' "TMB workspace with no default_repo and no .git at workspace root must block"
assert_contains "$out" "tmb_default_repo" "block message must mention tmb_default_repo config key"
assert_contains "$out" "config_set" "block message must suggest config_set remedy"
rm -rf "$WORKSPACE"
REPO_PATH=""

summarize
