#!/usr/bin/env bash
# WorktreeCreate hook. Routes worktree creation to the correct git repo.
#
# Contract (CC WorktreeCreate): stdout = bare absolute worktree path on success;
# exit 0 = success, non-zero = fail. No JSON dialect, no continue/defer.
#
# Reads CC's WorktreeCreate hook input (JSON via stdin). Extracts the
# requested branch name, then looks up the task by branch_id in the
# trajectory DB to find tasks.repo.
#
# Repo resolution order:
#   1. tasks.repo (matched by branch) → repos.path
#   2. single-repo fallback (repos.path when exactly one repo is registered)
#   3. WORKSPACE_ROOT — fallback for single-repo layouts where workspace IS the repo
#
# No-match (branch not in tasks table):
#   Create the worktree in the resolution-order repo (tasks.repo unavailable →
#   single-repo fallback → workspace root), creating the branch if it does not exist.
#
# DB-absent (non-TMB project):
#   Create under <cwd>/.claude/worktrees/<sanitized-branch> from the cwd repo.
#
# Runs `git -C <repo> worktree add <path> <branch>` inside the resolved repo.
# The worktree attaches to the named branch so SWE's commits advance the branch
# ref directly and pushes carry the commits.
#
# Worktree path: <repo_root>/.claude/worktrees/<slug>
# where slug strips the <type>/ prefix (fix/123-foo → 123-foo). Repo-rooted to
# match the creators (ensure-swe-worktree.sh / MCP task_provision) and the
# closers, so a repo nested under the launch workspace (e.g. TMB/plugin under
# TMB) resolves to one canonical path everywhere.
#
# Resolves <repo> relative to the workspace root (dir containing
# .claude/<plugin>/trajectory.db), found via tmb_db_path walk-up.
#
# Exits non-zero when:
#   - no branch in input (nothing to create)
#   - resolved repo is not a git work tree
#   - git worktree add fails

set -uo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"
# shellcheck source=scripts/hooks/lib/resolve-repo.sh
. "$PLUGIN_ROOT/scripts/hooks/lib/resolve-repo.sh"

INPUT=$(cat)

BRANCH_NAME=$(echo "$INPUT" | jq -r '.branch // ""' 2>/dev/null)
if [ -z "$BRANCH_NAME" ]; then
  printf 'tmb worktree-create: WorktreeCreate input has no .branch field — cannot create an isolated worktree; SWE will run non-isolated in the main checkout (supported). If isolation is required, ensure the spawn passes the task'"'"'s branch.\n' >&2
  exit 1
fi

# Slug: strip type/ prefix (fix/123-foo → 123-foo)
SLUG="${BRANCH_NAME#*/}"

DB_PATH=$(tmb_db_path 2>/dev/null) || true

# DB-absent: non-TMB project — create from cwd repo
if [ -z "$DB_PATH" ] || [ ! -f "$DB_PATH" ]; then
  CWD_REPO="$(pwd)"
  WORKTREE_PATH="$CWD_REPO/.claude/worktrees/$SLUG"
  if ! git -C "$CWD_REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'tmb worktree-create: no trajectory DB and cwd %s is not a git repo\n' \
      "$CWD_REPO" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$WORKTREE_PATH")"
  if [ -e "$WORKTREE_PATH/.git" ]; then
    printf 'tmb worktree-create: reusing existing worktree %s for branch %s\n' \
      "$WORKTREE_PATH" "$BRANCH_NAME" >&2
    echo "$WORKTREE_PATH"
    exit 0
  fi
  if ! git -C "$CWD_REPO" show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
    git -C "$CWD_REPO" branch "$BRANCH_NAME" HEAD >/dev/null 2>&1 \
      || { printf 'tmb worktree-create: could not create branch %s in %s\n' \
             "$BRANCH_NAME" "$CWD_REPO" >&2; exit 1; }
    printf 'tmb worktree-create: auto-created branch %s in %s\n' \
      "$BRANCH_NAME" "$CWD_REPO" >&2
  fi
  if ! git -C "$CWD_REPO" worktree add "$WORKTREE_PATH" "$BRANCH_NAME" >/dev/null 2>&1; then
    printf 'tmb worktree-create: git worktree add failed for branch %s in %s\n' \
      "$BRANCH_NAME" "$CWD_REPO" >&2
    exit 1
  fi
  printf 'tmb worktree-create: created worktree %s for branch %s (no-DB path)\n' \
    "$WORKTREE_PATH" "$BRANCH_NAME" >&2
  echo "$WORKTREE_PATH"
  exit 0
fi

tmb_have_sqlite || {
  printf 'tmb worktree-create: sqlite3 unavailable\n' >&2
  exit 1
}

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB_PATH")")")"

SAFE_BRANCH="$(printf '%s' "$BRANCH_NAME" | sed "s/'/''/g")"
TASK_COUNT=$(sqlite3 "$DB_PATH" \
  "SELECT COUNT(*) FROM tasks WHERE branch_id='$SAFE_BRANCH';" \
  2>/dev/null || echo 0)

if [ "$TASK_COUNT" = "0" ]; then
  # No matching task — single-repo fallback (repos.path), else workspace root.
  REPO_ABS=$(tmb_repo_single_path "$DB_PATH" 2>/dev/null || true)
  [ -n "$REPO_ABS" ] || REPO_ABS="$WORKSPACE_ROOT"
  WORKTREE_PATH="$REPO_ABS/.claude/worktrees/$SLUG"
else
  REPO=$(sqlite3 "$DB_PATH" \
    "SELECT COALESCE(repo,'') FROM tasks WHERE branch_id='$SAFE_BRANCH' LIMIT 1;" \
    2>/dev/null || true)

  # Resolve tasks.repo (a repo name) via repos.path; when it is unset, fall back
  # to the sole registered repo (single-repo), else the workspace root.
  REPO_ABS=$(tmb_repo_resolve_path "$DB_PATH" "$REPO" 2>/dev/null || true)
  [ -n "$REPO_ABS" ] || REPO_ABS="$WORKSPACE_ROOT"

  WORKTREE_PATH="$REPO_ABS/.claude/worktrees/$SLUG"
fi

# If the resolved repo isn't a git work tree, fail loudly
if ! git -C "$REPO_ABS" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'tmb worktree-create: resolved repo %s is not a git work tree\n' \
    "$REPO_ABS" >&2
  exit 1
fi

mkdir -p "$(dirname "$WORKTREE_PATH")"

# Idempotent: reuse an existing worktree at the canonical path
if [ -e "$WORKTREE_PATH/.git" ]; then
  printf 'tmb worktree-create: reusing existing worktree %s for branch %s\n' \
    "$WORKTREE_PATH" "$BRANCH_NAME" >&2
  echo "$WORKTREE_PATH"
  exit 0
fi

# Create the branch if it does not exist (harness expects creation to succeed)
if ! git -C "$REPO_ABS" show-ref --verify --quiet "refs/heads/$BRANCH_NAME" 2>/dev/null; then
  git -C "$REPO_ABS" branch "$BRANCH_NAME" HEAD >/dev/null 2>&1 \
    || { printf 'tmb worktree-create: could not create branch %s in %s\n' \
           "$BRANCH_NAME" "$REPO_ABS" >&2; exit 1; }
  printf 'tmb worktree-create: auto-created branch %s in %s\n' \
    "$BRANCH_NAME" "$REPO_ABS" >&2
fi

if ! git -C "$REPO_ABS" worktree add "$WORKTREE_PATH" "$BRANCH_NAME" >/dev/null 2>&1; then
  printf 'tmb worktree-create: git worktree add failed for branch %s in repo %s\n' \
    "$BRANCH_NAME" "$REPO_ABS" >&2
  exit 1
fi

printf 'tmb worktree-create: created worktree %s for branch %s in repo %s\n' \
  "$WORKTREE_PATH" "$BRANCH_NAME" "$REPO_ABS" >&2

echo "$WORKTREE_PATH"
