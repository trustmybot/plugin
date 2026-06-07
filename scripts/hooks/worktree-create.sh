#!/usr/bin/env bash
# WorktreeCreate hook (#110 Phase 2). Routes worktree creation to the correct
# git repo when tasks.repo is set.
#
# Reads CC's WorktreeCreate hook input (JSON via stdin). Extracts the
# requested branch name, then looks up the task by branch_id in the
# trajectory DB to find tasks.repo.
#
# Branches:
#   repo IS NULL/empty  → no-op JSON {"continue": true}. Single-repo CC
#                          continues with default worktree creation logic.
#   repo IS SET         → runs `git -C <repo> worktree add <path> <branch>`
#                          inside the resolved repo directory. The worktree
#                          attaches to the named branch so SWE's commits
#                          advance the branch ref directly and pushes carry
#                          the commits (#2869 / #2879).
#
# Worktree path: <workspace_root>/.claude/worktrees/<slug>
# where slug strips the <type>/ prefix (fix/123-foo → 123-foo).
#
# Resolves <repo> relative to the workspace root (dir containing
# .claude/<plugin>/trajectory.db), found via tmb_db_path walk-up.
#
# Silent pass-through (continue: true) when:
#   - no matching task found
#   - task.repo IS NULL/empty
#   - trajectory DB absent (not a TMB project)
#
# Exits non-zero if git worktree add fails (repo misconfigured or branch
# does not exist pre-created).

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"

INPUT=$(cat)

BRANCH_NAME=$(echo "$INPUT" | jq -r '.branch // ""' 2>/dev/null)
[ -n "$BRANCH_NAME" ] || { echo '{"continue":true}'; exit 0; }

DB_PATH=$(tmb_db_path 2>/dev/null) || true
if [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
  echo '{"continue":true}'
  exit 0
fi

tmb_have_sqlite || { echo '{"continue":true}'; exit 0; }

REPO=$(sqlite3 "$DB_PATH" \
  "SELECT repo FROM tasks WHERE branch_id='$(printf '%s' "$BRANCH_NAME" | sed "s/'/''/g")' LIMIT 1;" \
  2>/dev/null || true)

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB_PATH")")")"

# Resolve the repo that owns the branch. repo SET → workspace_root/<repo>
# (multi-repo routing). repo NULL/empty → single-repo CC, where the workspace
# root itself is the git repo. This is the sole worktree-creation path: bro no
# longer pre-creates the worktree manually, so the canonical .claude/worktrees/
# <slug> checkout must always come from here (#306).
if [ -n "$REPO" ]; then
  REPO_ABS="$WORKSPACE_ROOT/$REPO"
else
  REPO_ABS="$WORKSPACE_ROOT"
fi

# If the resolved repo isn't a git work tree, fall back to the harness default
# rather than hard-failing — keeps non-TMB / unusual layouts working.
if ! git -C "$REPO_ABS" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo '{"continue":true}'
  exit 0
fi

SLUG="${BRANCH_NAME#*/}"

# Worktree path is workspace-rooted (not repo-rooted) so .claude/ state stays
# out of inner git repos. The worktree is still git-attached to <repo> via
# `git -C <repo>` — git tracks it in <repo>/.git/worktrees/<slug>; the checkout
# files live at <workspace_root>/.claude/worktrees/<slug>/.
WORKTREE_PATH="$WORKSPACE_ROOT/.claude/worktrees/$SLUG"

mkdir -p "$(dirname "$WORKTREE_PATH")"

# Idempotent: if a worktree already lives at the canonical path, reuse it
# instead of a second `git worktree add` that fails "already exists" (#306).
if [ -e "$WORKTREE_PATH/.git" ]; then
  printf 'tmb worktree-create: reusing existing worktree %s for branch %s\n' \
    "$WORKTREE_PATH" "$BRANCH_NAME" >&2
  jq -nc --arg path "$WORKTREE_PATH" '{"continue":false,"worktreePath":$path}'
  exit 0
fi

if ! git -C "$REPO_ABS" worktree add "$WORKTREE_PATH" "$BRANCH_NAME" 2>&1; then
  printf 'tmb worktree-create: git worktree add failed for branch %s in repo %s\n' \
    "$BRANCH_NAME" "$REPO_ABS" >&2
  exit 1
fi

printf 'tmb worktree-create: created worktree %s for branch %s in repo %s\n' \
  "$WORKTREE_PATH" "$BRANCH_NAME" "$REPO_ABS" >&2

jq -nc --arg path "$WORKTREE_PATH" '{"continue":false,"worktreePath":$path}'
