#!/usr/bin/env bash
# Hook: Block SWE agent spawn when the task's branch_id does not yet exist.
# bro pre-creates <feature> without checking it out (the main checkout stays
# on <base>; SWE's worktree owns the branch ref). This gate verifies the
# branch exists before the worktree attaches to it.
#
# Bypass: TMB_ALLOW_BRANCH_MISMATCH=1 (emergency hotfix scenarios).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"

if [ "${TMB_ALLOW_BRANCH_MISMATCH:-0}" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')")
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

[ "$AGENT_TYPE" = "swe" ] || exit 0

TASK_ID=$(echo "$PROMPT" | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//')
[ -n "$TASK_ID" ] || exit 0  # require-task-spec.sh handles the missing-task_id case
SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
[ -n "$SAFE_TASK_ID" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then exit 0; fi

ROW=$(sqlite3 "$DB" "SELECT branch_id, repo, parent_branch_id FROM tasks WHERE id=${SAFE_TASK_ID};" 2>/dev/null || true)
[ -n "$ROW" ] || exit 0

EXPECTED=$(echo "$ROW" | cut -d'|' -f1)
REPO=$(echo "$ROW" | cut -d'|' -f2)
PARENT_BRANCH=$(echo "$ROW" | cut -d'|' -f3)

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB")")")"

if [ -n "$REPO" ]; then
  # Resolve the absolute path from the `repos` table (authoritative — set by
  # /scan), matched by name. Falls back to the legacy workspace-join only when
  # no matching repo row exists (e.g. pre-scan or non-workspace layout).
  REPO_ABS=$(tmb_repo_path_by_name "$DB" "$REPO")
  if [ -z "$REPO_ABS" ]; then
    REPO_ABS="$WORKSPACE_ROOT/$REPO"
  fi
  if [ ! -d "$REPO_ABS/.git" ]; then
    jq -nc --arg id "$TASK_ID" --arg repo "$REPO" --arg path "$REPO_ABS" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: cannot resolve repo for task "+$id+". tasks.repo="+$repo+" does not point to a git repo at "+$path+". Verify the path is correct.")}}'
    exit 0
  fi
else
  # No explicit task.repo. Single-repo fallback: if the repos table has exactly
  # one entry, use it (matches the resolveDefaultRepoPath MCP-side fallback for
  # single-repo projects). Otherwise fall back to the workspace root.
  REPO_ABS=$(tmb_repo_single_path "$DB")
  [ -n "$REPO_ABS" ] || REPO_ABS="$WORKSPACE_ROOT"
  if [ ! -d "$REPO_ABS/.git" ]; then
    jq -nc --arg id "$TASK_ID" \
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: cannot resolve repo for task "+$id+". tasks.repo IS NULL and no single registered repo could be resolved. For a multi-repo workspace, set the task'"'"'s repo (task_create repo=<name>) so it maps to a repos row.")}}'
    exit 0
  fi
fi

# The prerequisite is that <feature> EXISTS (bro pre-created it), not that the
# main checkout is on it — the main checkout stays on <base>.
if ! git -C "$REPO_ABS" show-ref --verify --quiet "refs/heads/$EXPECTED"; then
  # The remedy is a create command the executor runs verbatim, so it must be
  # correct for this repo. Use the task's concrete parent branch when known,
  # else a <base> placeholder. Prefix origin/ only when the repo actually has
  # an origin remote — a remoteless repo would choke on origin/<base>.
  BASE="${PARENT_BRANCH:-<base>}"
  if git -C "$REPO_ABS" remote get-url origin >/dev/null 2>&1; then
    BASE_REF="origin/$BASE"
  else
    BASE_REF="$BASE"
  fi
  jq -nc --arg id "$TASK_ID" --arg branch "$EXPECTED" --arg repo "$REPO_ABS" --arg base "$BASE" --arg baseref "$BASE_REF" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":("BLOCKED: SWE spawn for task "+$id+" needs branch "+$branch+" to exist first — bro pre-creates it (\"git -C "+$repo+" branch "+$branch+" "+$baseref+"\") and stays on "+$base+"; SWE'\''s worktree owns the branch.")}}'
  exit 0
fi

exit 0
