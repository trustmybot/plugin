#!/usr/bin/env bash
# Tests for scripts/hooks/worktree-create.sh.
# Hook contract: WorktreeCreate event. When task.repo is set, creates the
# worktree inside that repo. When repo is NULL/empty or no matching task,
# returns {"continue":true} (no-op, CC default takes over).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/worktree-create.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# --- fixture workspace -------------------------------------------------------
# Layout:
#   WORKSPACE/
#     .claude/tmb/trajectory.db   (DB with tasks)
#     inner/                      (the "inner" git repo tasks point at)

WORKSPACE="$TMPDIR/workspace"
INNER_REPO="$WORKSPACE/inner"

mkdir -p "$INNER_REPO"

git init -q -b main "$INNER_REPO"
cd "$INNER_REPO"
git config user.email t@t.io && git config user.name t
echo init > README.md && git add . && git commit -qm init

DB="$WORKSPACE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    branch_id TEXT NOT NULL,
    status TEXT,
    repo TEXT
  );
  INSERT INTO tasks (id, branch_id, status, repo)
    VALUES (1, 'fix/123-with-repo', 'pending', 'inner');
  INSERT INTO tasks (id, branch_id, status, repo)
    VALUES (2, 'feat/456-no-repo', 'pending', NULL);
"
export TRAJECTORY_DB_PATH="$DB"

git -C "$INNER_REPO" branch fix/123-with-repo HEAD

input_event() {
  local branch="$1"
  jq -n --arg branch "$branch" '{branch: $branch}'
}

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1
}

# --- tests -------------------------------------------------------------------

test_case "no branch in input: continue=true"
out=$(run_hook '{}')
assert_contains "$out" '"continue":true' "no branch → no-op"

test_case "branch with no matching task: continue=true"
out=$(run_hook "$(input_event 'feat/999-unknown')")
assert_contains "$out" '"continue":true' "unknown branch → no-op"

test_case "branch matching task with repo=NULL: continue=true"
out=$(run_hook "$(input_event 'feat/456-no-repo')")
assert_contains "$out" '"continue":true' "null repo → no-op"

test_case "branch matching task with repo set: worktree created at workspace-rooted path"
out=$(run_hook "$(input_event 'fix/123-with-repo')")
assert_not_contains "$out" '"continue":true' "repo set → not a no-op"
assert_contains "$out" '"continue":false' "repo set → continue=false"
assert_contains "$out" '123-with-repo' "worktree path contains slug"

WORKTREE_PATH="$WORKSPACE/.claude/worktrees/123-with-repo"
if [ -d "$WORKTREE_PATH" ]; then
  _pass
else
  _fail "worktree directory not created at $WORKTREE_PATH"
fi

test_case "worktree path is workspace-rooted, not repo-rooted, when workspace != repo"
# Workspace at $WORKSPACE, inner repo at $WORKSPACE/inner.
# tasks.repo='inner' → worktree must land at $WORKSPACE/.claude/worktrees/<slug>,
# NOT at $WORKSPACE/inner/.claude/worktrees/<slug>.
REPO_ROOTED_PATH="$INNER_REPO/.claude/worktrees/123-with-repo"
if [ -d "$REPO_ROOTED_PATH" ]; then
  _fail "worktree must NOT be created inside inner repo at $REPO_ROOTED_PATH"
else
  _pass
fi

test_case "worktree is a valid git worktree"
if git -C "$WORKTREE_PATH" rev-parse --git-dir >/dev/null 2>&1; then
  _pass
else
  _fail "worktree dir is not a valid git worktree"
fi

summarize
