#!/usr/bin/env bash
# Tests for scripts/hooks/ensure-swe-worktree.sh
#
# Hook contract: at swe-spawn time, deterministically create swe's worktree at
# the CANONICAL slug path (<repo-root>/.claude/worktrees/<slug>) via
# `git worktree add`. Only acts for swe spawns with task_id=<N>; non-swe and
# missing-task → no-op. NON-BLOCKING + fail-open: any error → stderr + exit 0,
# never a deny. Idempotent. Bypass: TMB_DISABLE_ENSURE_SWE_WORKTREE=1.
#
# Sandbox-isolated per #810: every fixture lives in a fresh mktemp git repo and
# is removed in cleanup — nothing is created in the plugin tree.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/ensure-swe-worktree.sh"

# ----- helpers ----------------------------------------------------------

# Create a fresh temp git repo with a base branch + a feature branch.
# Sets REPO_PATH. The feature branch is created but NOT checked out (mirrors
# bro pre-creating <feature> while the main checkout stays on <base>).
setup_repo() {
  local feature="${1:-fix/1-foo-bar}"
  local dir
  dir=$(mktemp -d -t tmb-ensure-wt-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b dev
    git config user.email "test@example.com"
    git config user.name  "Test"
    echo "init" > README.md
    git add README.md
    git commit -qm "init"
    git branch "$feature"
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

# Insert a minimal issue + task row (repo column optional).
insert_task() {
  local db="$1" task_id="$2" branch_id="$3" repo="${4:-}"
  local repo_sql="NULL"
  [ -n "$repo" ] && repo_sql="'$repo'"
  sqlite3 "$db" "
    INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
      VALUES ($task_id, 1, '$branch_id', 'task $task_id', 'd', 'pending', '## body', $repo_sql, datetime('now'), datetime('now'));
  " >/dev/null
}

make_payload() {
  local agent_type="$1" prompt="$2"
  jq -cn --arg a "$agent_type" --arg p "$prompt" \
    '{tool_input:{subagent_type:$a,prompt:$p}}'
}

# Run the hook from inside REPO_PATH with a pinned DB.
run_hook() {
  local payload="$1" db="${2:-/nonexistent.db}" extra_env="${3:-}"
  (
    cd "$REPO_PATH" || exit 1
    [ -n "$extra_env" ] && eval "export $extra_env"
    echo "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true
  )
}

# True when <repo> has a registered worktree at the given absolute path.
# git canonicalizes worktree paths (macOS /var → /private/var), so match on
# the .claude/worktrees/<slug> suffix rather than the raw mktemp prefix.
is_registered_worktree() {
  local repo="$1" wt_abs="$2"
  local slug="${wt_abs##*/}"
  git -C "$repo" worktree list --porcelain 2>/dev/null \
    | grep -qE "^worktree .*/\.claude/worktrees/${slug}$"
}

cleanup() {
  [ -n "${REPO_PATH:-}" ] && [ -d "${REPO_PATH:-}" ] && rm -rf "$REPO_PATH"
  [ -n "${WORKSPACE:-}" ] && [ -d "${WORKSPACE:-}" ] && rm -rf "$WORKSPACE"
  REPO_PATH=""
  WORKSPACE=""
}

# ----- tests ------------------------------------------------------------

test_case "swe + task → worktree created at canonical slug"
setup_repo "fix/1-foo-bar"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo-bar"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "prepare step must never deny"
WT="$REPO_PATH/.claude/worktrees/1-foo-bar"
assert_eq "yes" "$([ -d "$WT" ] && echo yes || echo no)" "canonical-slug worktree dir must exist"
assert_eq "yes" "$(is_registered_worktree "$REPO_PATH" "$WT" && echo yes || echo no)" "worktree must be registered with git"
cleanup

test_case "prefixed subagent_type (tmb:swe) is normalized and acts"
setup_repo "fix/2-baz"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 2 "fix/2-baz"
payload=$(make_payload "tmb:swe" "task_id=2 You are SWE.")
out=$(run_hook "$payload" "$db")
WT="$REPO_PATH/.claude/worktrees/2-baz"
assert_eq "yes" "$([ -d "$WT" ] && echo yes || echo no)" "tmb:swe must normalize to swe and create the worktree"
cleanup

test_case "idempotent: re-run with the worktree present is a no-op (no error, still allowed)"
setup_repo "fix/1-foo-bar"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo-bar"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
run_hook "$payload" "$db" >/dev/null
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "idempotent re-run must not deny"
WT="$REPO_PATH/.claude/worktrees/1-foo-bar"
assert_eq "yes" "$(is_registered_worktree "$REPO_PATH" "$WT" && echo yes || echo no)" "worktree must remain registered after re-run"
# Exactly one worktree at that path (no duplicate).
count=$(git -C "$REPO_PATH" worktree list --porcelain | grep -cE "^worktree .*/\.claude/worktrees/1-foo-bar$")
assert_eq "1" "$count" "no duplicate worktree after idempotent re-run"
cleanup

test_case "non-swe spawn → no-op (no worktree created, never denies)"
setup_repo "fix/1-foo-bar"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo-bar"
payload=$(make_payload "pr-reviewer" "task_id=1 You are pr-reviewer.")
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "non-swe must never deny"
WT="$REPO_PATH/.claude/worktrees/1-foo-bar"
assert_eq "no" "$([ -d "$WT" ] && echo yes || echo no)" "non-swe spawn must not create a worktree"
cleanup

test_case "no task_id in prompt → no-op + allow"
setup_repo "fix/1-foo-bar"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo-bar"
payload=$(make_payload "swe" "You are SWE but no task id here.")
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "missing task_id must never deny"
WT="$REPO_PATH/.claude/worktrees/1-foo-bar"
assert_eq "no" "$([ -d "$WT" ] && echo yes || echo no)" "missing task_id must not create a worktree"
cleanup

test_case "git worktree add fails (branch missing) → allow (fail-open)"
setup_repo "fix/1-foo-bar"
# Drop the feature branch so 'git worktree add <branch>' fails.
git -C "$REPO_PATH" branch -D "fix/1-foo-bar" >/dev/null 2>&1
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo-bar"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(run_hook "$payload" "$db")
assert_not_contains "$out" '"permissionDecision":"deny"' "git-add failure must fail open (no deny)"
WT="$REPO_PATH/.claude/worktrees/1-foo-bar"
assert_eq "no" "$([ -d "$WT" ] && echo yes || echo no)" "failed add must not leave a registered worktree"
cleanup

test_case "bypass TMB_DISABLE_ENSURE_SWE_WORKTREE=1 → no-op"
setup_repo "fix/1-foo-bar"
db=$(setup_db "$REPO_PATH")
insert_task "$db" 1 "fix/1-foo-bar"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(run_hook "$payload" "$db" "TMB_DISABLE_ENSURE_SWE_WORKTREE=1")
assert_not_contains "$out" '"permissionDecision":"deny"' "bypass must never deny"
WT="$REPO_PATH/.claude/worktrees/1-foo-bar"
assert_eq "no" "$([ -d "$WT" ] && echo yes || echo no)" "bypass must skip worktree creation"
cleanup

test_case "TMB workspace shape: tasks.repo names a registered repo → worktree at that repo root"
WORKSPACE=$(mktemp -d -t tmb-ensure-wt-ws-XXXX)
INNER_REPO="$WORKSPACE/plugin"
mkdir -p "$INNER_REPO"
(
  cd "$INNER_REPO" || exit 1
  git init -q -b dev
  git config user.email "test@example.com"
  git config user.name "Test"
  echo "init" > README.md
  git add README.md
  git commit -qm "init"
  git branch "fix/3-widget"
)
INNER_ROOT=$(git -C "$INNER_REPO" rev-parse --show-toplevel)
WS_DB="$WORKSPACE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$WS_DB")"
sqlite3 "$WS_DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
sqlite3 "$WS_DB" "
  INSERT INTO repos (name, path) VALUES ('plugin', '$INNER_ROOT');
  INSERT OR IGNORE INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, repo, created_at, updated_at)
    VALUES (3, 1, 'fix/3-widget', 'task 3', 'd', 'pending', '## body', 'plugin', datetime('now'), datetime('now'));
" >/dev/null
REPO_PATH="$INNER_REPO"
payload=$(make_payload "swe" "task_id=3 You are SWE.")
out=$(run_hook "$payload" "$WS_DB")
assert_not_contains "$out" '"permissionDecision":"deny"' "workspace-shape spawn must never deny"
WT="$INNER_ROOT/.claude/worktrees/3-widget"
assert_eq "yes" "$([ -d "$WT" ] && echo yes || echo no)" "worktree must be created under the named repo root"
assert_eq "yes" "$(is_registered_worktree "$INNER_ROOT" "$WT" && echo yes || echo no)" "worktree must be registered with git"
cleanup

test_case "no DB → no-op + allow (not a TMB project)"
setup_repo "fix/1-foo-bar"
payload=$(make_payload "swe" "task_id=1 You are SWE.")
out=$(run_hook "$payload" "/nonexistent/trajectory.db")
assert_not_contains "$out" '"permissionDecision":"deny"' "missing DB must never deny"
WT="$REPO_PATH/.claude/worktrees/1-foo-bar"
assert_eq "no" "$([ -d "$WT" ] && echo yes || echo no)" "missing DB must not create a worktree"
cleanup

summarize
