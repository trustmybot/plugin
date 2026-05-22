#!/usr/bin/env bash
# PostToolUse hook (#171 follow-up). When bro flips a task to `closed`, the
# corresponding SWE worktree is no longer needed — its commits live on the
# branch (which stays for push-gate review). This hook removes the worktree
# directory + prunes git's internal tracking, freeing disk + keeping
# .claude/worktrees/ tidy.
#
# Triggers ONLY on:
#   - tool_name = mcp__plugin_<channel>_trajectory-server__task_update_status
#   - args.agent = 'bro'
#   - args.status = 'closed'
#   - the task row has a branch_id with a matching worktree
#
# Silent no-op when:
#   - any of the above don't match
#   - DB / git missing
#   - worktree already removed
#   - bypass: TMB_KEEP_CLOSED_WORKTREES=1
#
# Reports cleanup to stderr (visible in CC's debug log; not user-blocking).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  mcp__*trajectory-server__task_update_status) ;;
  *) exit 0 ;;
esac

if [ "${TMB_KEEP_CLOSED_WORKTREES:-0}" = "1" ]; then
  exit 0
fi

AGENT=$(echo "$INPUT" | jq -r '.tool_input.agent // ""' 2>/dev/null)
STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // ""' 2>/dev/null)
TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // ""' 2>/dev/null)

[ "$AGENT" = "bro" ] || exit 0
[ "$STATUS" = "closed" ] || exit 0
[ -n "$TASK_ID" ] || exit 0

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

BRANCH_ID=$(sqlite3 "$DB_PATH" "SELECT branch_id FROM tasks WHERE id=$TASK_ID LIMIT 1;" 2>/dev/null)
[ -n "$BRANCH_ID" ] || exit 0

TASK_REPO=$(sqlite3 "$DB_PATH" "SELECT repo FROM tasks WHERE id=$TASK_ID LIMIT 1;" 2>/dev/null || true)
if [ -z "$TASK_REPO" ]; then
  TASK_REPO=$(sqlite3 "$DB_PATH" "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key='tmb_default_repo';" 2>/dev/null || true)
fi

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB_PATH")")")"
if [ -n "$TASK_REPO" ]; then
  # Prefer the absolute path recorded in the `repos` table (authoritative
  # — set by /scan). Falls back to legacy workspace-join only when no
  # matching repo row exists.
  REPO_ROOT=$(sqlite3 "$DB_PATH" "SELECT path FROM repos WHERE name='$TASK_REPO' LIMIT 1;" 2>/dev/null || true)
  [ -z "$REPO_ROOT" ] && REPO_ROOT="$WORKSPACE_ROOT/$TASK_REPO"
else
  # Single-repo fallback when no default config.
  REPO_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM repos;" 2>/dev/null || echo 0)
  if [ "$REPO_COUNT" = "1" ]; then
    REPO_ROOT=$(sqlite3 "$DB_PATH" "SELECT path FROM repos LIMIT 1;" 2>/dev/null || true)
    [ -z "$REPO_ROOT" ] && REPO_ROOT="$WORKSPACE_ROOT"
  else
    REPO_ROOT="$WORKSPACE_ROOT"
  fi
fi
[ -d "$REPO_ROOT/.git" ] || exit 0

SLUG="${BRANCH_ID#*/}"
# The regex tolerates both repo-rooted (legacy: <repo>/.claude/worktrees/<slug>)
# and workspace-rooted (current: <workspace>/.claude/worktrees/<slug>) paths
# because both end in `/.claude/worktrees/<slug>`. After all stale repo-rooted
# worktrees are pruned (see scripts/maintenance/cleanup-stale-worktrees.sh),
# only workspace-rooted ones remain.
WORKTREE_PATH=$(git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | awk -v slug="$SLUG" '
  /^worktree / {
    wt = substr($0, 10);
    if (wt ~ ("/\\.claude/worktrees/" slug "$")) { print wt; exit }
  }
')

[ -n "$WORKTREE_PATH" ] || exit 0
[ "$WORKTREE_PATH" != "$REPO_ROOT" ] || exit 0

git -C "$REPO_ROOT" worktree remove "$WORKTREE_PATH" --force >/dev/null 2>&1 || {
  printf 'tmb: worktree remove failed for %s — leaving in place\n' "$WORKTREE_PATH" >&2
  exit 0
}

git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true

# Post-close cleanup: reset the main checkout's HEAD back to the project's
# base branch (pr_target). Without this, follow-on asks inherit the
# feature-branch checkout from the just-closed task — which has caused
# L6 chain regressions because bro's next-turn worktree mechanics get
# tangled trying to plan from the wrong base.
#
# Bypass: TMB_KEEP_HEAD_ON_CLOSE=1 (rare — e.g. when the Human deliberately
# wants to stay on the feature branch for follow-on inspection).
if [ "${TMB_KEEP_HEAD_ON_CLOSE:-0}" != "1" ]; then
  PR_TARGET=$(sqlite3 "$DB_PATH" "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key='pr_target';" 2>/dev/null | sed -e 's/^"//' -e 's/"$//' || true)
  PR_TARGET="${PR_TARGET:-dev}"
  # Only checkout if (a) the target branch exists and (b) we're not already on it.
  CURRENT_HEAD=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if git -C "$REPO_ROOT" rev-parse --verify "$PR_TARGET" >/dev/null 2>&1 && [ "$CURRENT_HEAD" != "$PR_TARGET" ]; then
    if git -C "$REPO_ROOT" checkout "$PR_TARGET" >/dev/null 2>&1; then
      printf 'tmb: checked out %s after task #%s closed (was on %s)\n' "$PR_TARGET" "$TASK_ID" "$CURRENT_HEAD" >&2
    else
      printf 'tmb: post-close checkout of %s failed — leaving on %s\n' "$PR_TARGET" "$CURRENT_HEAD" >&2
    fi
  fi
fi

printf 'tmb: cleaned up worktree %s after task #%s closed\n' "$WORKTREE_PATH" "$TASK_ID" >&2
