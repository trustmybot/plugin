#!/usr/bin/env bash
# PostToolUse hook (#171 follow-up). Once a task's work is done and reviewed,
# its SWE worktree is no longer needed — its commits live on the branch. This
# hook removes the worktree directory + prunes git's internal tracking,
# freeing disk + keeping .claude/worktrees/ tidy.
#
# Triggers ONLY on:
#   - task_update_status with args.agent = 'bro' and args.status = 'closed'
#   - validation_record with args.verdict = 'pass', when the task is closed and
#     carries a passing review for its current commit (_CWC_HAS_PASS)
#   - the task row has a branch_id with a matching worktree
# bro_atomic_close runs before pr-reviewer, so it leaves the worktree in place:
# a failed review reworks in the same worktree (task_reopen).
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
# shellcheck source=lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

# Byte-identical copy of lifecycle.ts HAS_PASS_SQL (lifecycle.test.ts pins
# them equal): a pass verdict counts only at or after the earliest
# bro_verification_pass naming the task and its current commit. `t` is the
# task alias.
_CWC_HAS_PASS="EXISTS (SELECT 1 FROM validation_attempts va
  WHERE va.task_id = t.id AND va.verdict = 'pass' AND va.created_at >= (
    SELECT MIN(a.created_at) FROM audit a
      WHERE a.event_type = 'bro_verification_pass' AND json_valid(a.content_json)
        AND json_extract(a.content_json, '\$.task_id') = t.id
        AND json_extract(a.content_json, '\$.commit_sha') = t.commit_sha))"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  mcp__*trajectory-server__task_update_status) ;;
  mcp__*trajectory-server__validation_record)  ;;
  *) exit 0 ;;
esac

if [ "${TMB_KEEP_CLOSED_WORKTREES:-0}" = "1" ]; then
  exit 0
fi

AGENT=$(echo "$INPUT" | jq -r '.tool_input.agent // ""' 2>/dev/null)
TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // ""' 2>/dev/null)

case "$TOOL_NAME" in
  *validation_record)
    [ "$(echo "$INPUT" | jq -r '.tool_input.verdict // ""' 2>/dev/null)" = "pass" ] || exit 0
    ;;
  *)
    [ "$AGENT" = "bro" ] || exit 0
    [ "$(echo "$INPUT" | jq -r '.tool_input.status // ""' 2>/dev/null)" = "closed" ] || exit 0
    ;;
esac
[ -n "$TASK_ID" ] || exit 0

SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
[ -n "$SAFE_TASK_ID" ] || exit 0

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

case "$TOOL_NAME" in
  *validation_record)
    case "$_CWC_HAS_PASS" in "EXISTS (SELECT 1 FROM validation_attempts va"*) ;; *) exit 0 ;; esac
    PASSED=$(tmb_sqlite_ro "$DB_PATH" "SELECT 1 FROM tasks t WHERE t.id=${SAFE_TASK_ID} AND t.status='closed' AND ${_CWC_HAS_PASS};")
    [ "$PASSED" = "1" ] || exit 0
    ;;
esac

BRANCH_ID=$(tmb_sqlite_ro "$DB_PATH" "SELECT branch_id FROM tasks WHERE id=${SAFE_TASK_ID} LIMIT 1;")
[ -n "$BRANCH_ID" ] || exit 0

TASK_REPO=$(tmb_sqlite_ro "$DB_PATH" "SELECT repo FROM tasks WHERE id=${SAFE_TASK_ID} LIMIT 1;")

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB_PATH")")")"
if [ -n "$TASK_REPO" ]; then
  # Resolve the absolute path from the `repos` table (authoritative — set by
  # /scan), matched by name. Falls back to legacy workspace-join only when no
  # matching repo row exists.
  REPO_ROOT=$(tmb_repo_path_by_name "$DB_PATH" "$TASK_REPO")
  [ -z "$REPO_ROOT" ] && REPO_ROOT="$WORKSPACE_ROOT/$TASK_REPO"
else
  # Single-repo fallback when task.repo is unset.
  REPO_ROOT=$(tmb_repo_single_path "$DB_PATH")
  [ -z "$REPO_ROOT" ] && REPO_ROOT="$WORKSPACE_ROOT"
fi
[ -d "$REPO_ROOT/.git" ] || exit 0

SLUG=$(tmb_branch_slug "$BRANCH_ID")
# Worktrees are created repo-rooted at <repo>/.claude/worktrees/<slug> by the
# creators (ensure-swe-worktree.sh / MCP task_provision). `git worktree list`
# enumerates them by git's own tracking regardless of physical location, so the
# slug-suffix match below locates the worktree by its `/.claude/worktrees/<slug>`
# tail without assuming any particular root.
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
  _REPO_ROW=$(tmb_repo_resolve "$DB_PATH" "$REPO_ROOT")
  PR_TARGET=$(printf '%s' "$_REPO_ROW" | cut -d'|' -f1)
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
