#!/usr/bin/env bash
# Regression for !2899: bro skipped pr-reviewer on 9 audit-fix MRs because
# git-push-guard.sh exited early on first-push (no @{u} → empty PUSH_SHAS → exit 0).
#
# This test simulates the exact !2899 scenario end-to-end:
#   task created → atomic-close assigns commit_sha → git push -u origin <branch>
#   with NO pr-reviewer verdict written yet.
#
# Pre-fix: hook allows the push (PUSH_SHAS empty, exits 0).
# Post-fix: hook blocks the push (falls back to origin/$pr_target..HEAD).

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-push-guard.sh"

# ----- helpers ----------------------------------------------------------

setup_bro_skip_repo() {
  local dir
  dir=$(mktemp -d -t tmb-bro-skip-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b dev
    git config user.email "test@example.com"
    git config user.name  "Test"

    git init --bare -q upstream.git
    git remote add origin "$dir/upstream.git"

    # Push dev base so origin/dev exists (needed for fallback range)
    echo "init" > README.md
    git add README.md
    git commit -qm "init"
    git push -qu origin dev

    # Bro creates a feature branch (SWE's work)
    git switch -q -c chore/audit-fix-42

    echo "fix" > fix.txt
    git add fix.txt
    git commit -qm "chore: audit fix 42"

    git rev-parse HEAD > .commit_sha
    # NOTE: no `git push` yet — this branch has NO upstream
  )
  REPO_PATH="$dir"
  COMMIT_SHA=$(cat "$dir/.commit_sha")
}

setup_db() {
  local repo="$1"
  local db="$repo/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$db")"
  sqlite3 "$db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  echo "$db"
}

insert_closed_task() {
  local db="$1" sha="$2"
  sqlite3 "$db" "
    INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'audit fix', 'audit fix', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at)
      VALUES (42, 1, 'chore/audit-fix-42', 'audit fix 42', 'd', 'closed', '## body', '$sha', datetime('now'), datetime('now'));
  " >/dev/null
}

set_pr_target() {
  local db="$1" target="$2"
  sqlite3 "$db" "
    INSERT OR REPLACE INTO plugin_config (key, value_json)
      VALUES ('pr_target', '\"$target\"');
  " >/dev/null
}

sign_task() {
  local db="$1" task_id="$2"
  sqlite3 "$db" "
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, feedback, created_at)
      VALUES ($task_id, 1, 'pr-reviewer', 'pass', 'MCP available: yes' || char(10) || 'LGTM', datetime('now'));
  " >/dev/null
}

run_hook() {
  local cmd="$1"
  local db="${2:-/nonexistent.db}"
  local payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  (cd "$REPO_PATH" && echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

cleanup() {
  [ -n "${REPO_PATH:-}" ] && [ -d "${REPO_PATH:-}" ] && rm -rf "$REPO_PATH"
  REPO_PATH=""
}

# ----- tests ------------------------------------------------------------

test_case "!2899 regression: bro atomic-close then git push -u origin (no pr-reviewer) — BLOCKED"
setup_bro_skip_repo
db=$(setup_db "$REPO_PATH")
set_pr_target "$db" "dev"
insert_closed_task "$db" "$COMMIT_SHA"
# No validation_attempts row — simulates bro skipping pr-reviewer
out=$(run_hook "git push -u origin chore/audit-fix-42" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "push without pr-reviewer verdict must be blocked"
assert_contains "$out" "task_id=42" "block message must name the unsigned task"
assert_contains "$out" "review before push" "block message must direct to review path"
cleanup

test_case "!2899 regression: bro atomic-close then git push -u origin WITH pr-reviewer pass — ALLOWED"
setup_bro_skip_repo
db=$(setup_db "$REPO_PATH")
set_pr_target "$db" "dev"
insert_closed_task "$db" "$COMMIT_SHA"
sign_task "$db" 42
out=$(run_hook "git push -u origin chore/audit-fix-42" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "push with pr-reviewer pass verdict must be allowed"
cleanup

test_case "!2899 regression: multiple unsigned tasks on new branch — all blocked"
setup_bro_skip_repo
db=$(setup_db "$REPO_PATH")
set_pr_target "$db" "dev"
# Add a second commit and task on the same feature branch
(
  cd "$REPO_PATH" || exit 1
  echo "fix2" > fix2.txt
  git add fix2.txt
  git commit -qm "chore: audit fix 43"
  git rev-parse HEAD > .commit_sha2
)
COMMIT_SHA2=$(cat "$REPO_PATH/.commit_sha2")
insert_closed_task "$db" "$COMMIT_SHA"
sqlite3 "$db" "
  INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at)
    VALUES (43, 1, 'chore/audit-fix-43', 'audit fix 43', 'd', 'closed', '## body', '$COMMIT_SHA2', datetime('now'), datetime('now'));
" >/dev/null
# Neither signed
out=$(run_hook "git push -u origin chore/audit-fix-42" "$db")
assert_contains "$out" '"permissionDecision":"deny"' "multiple unsigned tasks must block"
assert_contains "$out" "task_id=42" "must list task 42"
assert_contains "$out" "task_id=43" "must list task 43"
cleanup

summarize
