#!/usr/bin/env bash
# Hook: Block SWE agent spawn when the main checkout is not on the task's branch_id.
# Queries trajectory.db for the task's branch_id and repo, then compares against
# the current branch of the main checkout.
#
# Bypass: TMB_ALLOW_BRANCH_MISMATCH=1 (emergency hotfix scenarios).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

if [ "${TMB_ALLOW_BRANCH_MISMATCH:-0}" = "1" ]; then
  exit 0
fi

INPUT=$(cat)
AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')")
PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty')

[ "$AGENT_TYPE" = "swe" ] || exit 0

TASK_ID=$(echo "$PROMPT" | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//')
[ -n "$TASK_ID" ] || exit 0  # require-task-spec.sh handles the missing-task_id case

DB=$(tmb_db_path 2>/dev/null || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then exit 0; fi

ROW=$(sqlite3 "$DB" "SELECT branch_id, repo FROM tasks WHERE id=$TASK_ID;" 2>/dev/null || true)
[ -n "$ROW" ] || exit 0

EXPECTED=$(echo "$ROW" | cut -d'|' -f1)
REPO=$(echo "$ROW" | cut -d'|' -f2)

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB")")")"

if [ -z "$REPO" ]; then
  REPO=$(sqlite3 "$DB" "SELECT json_extract(value_json, '$') FROM plugin_config WHERE key='tmb_default_repo';" 2>/dev/null || true)
fi

if [ -n "$REPO" ]; then
  REPO_ABS="$WORKSPACE_ROOT/$REPO"
  if [ ! -d "$REPO_ABS/.git" ]; then
    cat <<EOF
{"decision":"block","reason":"BLOCKED: cannot resolve repo for task $TASK_ID. tasks.repo='$REPO' does not point to a git repo at '$REPO_ABS'. Verify the path is correct."}
EOF
    exit 0
  fi
else
  REPO_ABS="$WORKSPACE_ROOT"
  if [ ! -d "$REPO_ABS/.git" ]; then
    cat <<EOF
{"decision":"block","reason":"BLOCKED: cannot resolve repo for task $TASK_ID. tasks.repo IS NULL and tmb_default_repo config is unset. Set via \`config_set tmb_default_repo <inner>\` for multi-repo workspaces."}
EOF
    exit 0
  fi
fi

ACTUAL=$(git -C "$REPO_ABS" branch --show-current 2>/dev/null || true)

if [ "$ACTUAL" != "$EXPECTED" ]; then
  cat <<EOF
{"decision":"block","reason":"BLOCKED: SWE spawn requires main checkout on branch '$EXPECTED' (task $TASK_ID), got '$ACTUAL'. Run 'git -C $REPO_ABS switch $EXPECTED' first. This invariant is documented in docs/architecture/GIT.md and enforced by hooks (#155)."}
EOF
  exit 0
fi

exit 0
