#!/usr/bin/env bash
# WorktreeCreate hook (#110 Phase 2). Routes worktree creation to the correct
# git repo when tasks.repo is set.
#
# Reads CC's WorktreeCreate hook input (JSON via stdin). Extracts the
# requested branch name, then looks up the task by branch_id in the
# trajectory DB to find tasks.repo.
#
# Repo resolution order:
#   1. tasks.repo (matched by branch)
#   2. tmb_default_repo (plugin_config) — used when CWD is not a git repo
#   3. WORKSPACE_ROOT — fallback for single-repo layouts where workspace IS the repo
#
# Runs `git -C <repo> worktree add <path> <branch>` inside the resolved repo.
# The worktree attaches to the named branch so SWE's commits advance the branch
# ref directly and pushes carry the commits (#2869 / #2879).
#
# Worktree path: <workspace_root>/.claude/worktrees/<slug>
# where slug strips the <type>/ prefix (fix/123-foo → 123-foo).
#
# Resolves <repo> relative to the workspace root (dir containing
# .claude/<plugin>/trajectory.db), found via tmb_db_path walk-up.
#
# Silent pass-through (continue: true) when:
#   - no branch in input
#   - no matching task found
#   - trajectory DB absent (not a TMB project)
#
# Exits non-zero when:
#   - resolved repo is not a git work tree (DB present = known TMB project)
#   - git worktree add fails (branch does not exist pre-created)

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

SAFE_BRANCH="$(printf '%s' "$BRANCH_NAME" | sed "s/'/''/g")"
TASK_COUNT=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM tasks WHERE branch_id='$SAFE_BRANCH';" \
  2>/dev/null || echo 0)

# No matching task → not a TMB-managed branch; defer to the harness default.
if [ "$TASK_COUNT" = "0" ]; then
  echo '{"continue":true}'
  exit 0
fi

REPO=$(sqlite3 "$DB_PATH" \
  "SELECT COALESCE(repo,'') FROM tasks WHERE branch_id='$SAFE_BRANCH' LIMIT 1;" \
  2>/dev/null || true)

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB_PATH")")")"
DEFAULT_REPO=""

# Resolve the repo that owns the branch.
# Priority: tasks.repo → tmb_default_repo (plugin_config) → WORKSPACE_ROOT.
if [ -n "$REPO" ]; then
  # tasks.repo is set: may be relative or absolute
  case "$REPO" in
    /*) REPO_ABS="$REPO" ;;
    *)  REPO_ABS="$WORKSPACE_ROOT/$REPO" ;;
  esac
else
  DEFAULT_REPO=$(tmb_config_get "tmb_default_repo" 2>/dev/null || true)
  if [ -n "$DEFAULT_REPO" ]; then
    case "$DEFAULT_REPO" in
      /*) REPO_ABS="$DEFAULT_REPO" ;;
      *)  REPO_ABS="$WORKSPACE_ROOT/$DEFAULT_REPO" ;;
    esac
  else
    REPO_ABS="$WORKSPACE_ROOT"
  fi
fi

# If the resolved repo isn't a git work tree, fail loudly — silently continuing
# into the harness default produces an opaque "not a directory" error from CC.
if ! git -C "$REPO_ABS" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'tmb worktree-create: resolved repo %s is not a git work tree (task repo=%s, default_repo=%s, workspace=%s)\n' \
    "$REPO_ABS" "${REPO:-}" "$DEFAULT_REPO" "$WORKSPACE_ROOT" >&2
  exit 1
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
