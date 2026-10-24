#!/usr/bin/env bash
# PreToolUse(Agent) PREPARE step — record a swe spawn in the trajectory DB.
#
# Runs from agent-spawn-dispatch.sh after every spawn gate passed, for a
# `subagent_type` resolving to swe whose prompt names `task_id=<N>`. One
# transaction:
#   - a pending task moves to running (updated_at = now, completed_at cleared,
#     as task_update_status does for that move; it writes no audit row);
#   - one open swe agent_runs row is inserted: session_id = the payload's
#     session_id, effort = tool_input.effort (else tasks.effort), model =
#     tool_input.model when set, spawn_id = tool_use:<payload tool_use_id>
#     (tool_use:<session_id>:<epoch_ms> when the payload has none), started_at,
#     repo, issue_id, host claude and root_dir = the task worktree.
# The same transaction first closes the task's open swe rows no subagent bound
# (spawn_id NULL or tool_use:*) that are older than 90 s: spawns refused after
# this step (a manual denial, a deny rule, a hook block) that never started.
# Each takes completed_at = now, exit_reason swept_orphan, usage_source
# unmeasured when unset and duration_ms its window length when unmeasured; a
# row bound to an agent id is never touched.
# swe-spawn-bind.sh rebinds the new row to the subagent's agent_id once CC
# accepts the spawn (PostToolUse), else swe-brief-gate.sh does at its first
# task_brief; swe-spawn-rollback.sh closes it when auto mode refuses the spawn
# (PermissionDenied), and swe-atomic-close.sh meters it at SubagentStop.
#
# This step ACTS, it does NOT gate: fail-open, it never denies the spawn and a
# failed write leaves the DB unchanged.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/resolve-repo.sh
. "$SCRIPT_DIR/lib/resolve-repo.sh"
# shellcheck source=lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

AGENT_TYPE=$(tmb_normalize_role "$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null)")
[ "$AGENT_TYPE" = "swe" ] || exit 0

PROMPT=$(printf '%s' "$INPUT" | jq -r '.tool_input.prompt // empty' 2>/dev/null)
TASK_ID=$(printf '%s' "$PROMPT" | grep -oE 'task_id[=:][[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
[ -n "$SAFE_TASK_ID" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
if [ -z "$DB" ] || ! tmb_have_sqlite; then
  exit 0
fi

ROW=$(tmb_sqlite_ro "$DB" "SELECT branch_id, COALESCE(repo, '') FROM tasks WHERE id = ${SAFE_TASK_ID};")
[ -n "$ROW" ] || exit 0
BRANCH=$(printf '%s' "$ROW" | cut -d'|' -f1)
REPO=$(printf '%s' "$ROW" | cut -d'|' -f2)

FIELDS=$(printf '%s' "$INPUT" | jq -r '[.session_id // "", .tool_use_id // "", .tool_input.effort // "", .tool_input.model // ""] | map(tostring) | join("\u001f")' 2>/dev/null) || exit 0
IFS=$'\037' read -r SESSION_ID TOOL_USE_ID EFFORT MODEL <<< "$FIELDS"

if [ -n "$TOOL_USE_ID" ]; then
  SPAWN_ID="tool_use:${TOOL_USE_ID}"
else
  SPAWN_ID="tool_use:${SESSION_ID}:$(_tmb_now_ms)"
fi

WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$DB")")")"
if [ -n "$REPO" ]; then
  REPO_ROOT=$(tmb_repo_path_by_name "$DB" "$REPO")
  [ -n "$REPO_ROOT" ] || REPO_ROOT="$WORKSPACE_ROOT/$REPO"
else
  REPO_ROOT=$(tmb_repo_single_path "$DB")
  [ -n "$REPO_ROOT" ] || REPO_ROOT="$WORKSPACE_ROOT"
fi
ROOT_DIR_SQL="NULL"
[ -n "$BRANCH" ] && ROOT_DIR_SQL="'$(tmb_sql_quote "${REPO_ROOT%/}/.claude/worktrees/$(tmb_branch_slug "$BRANCH")")'"

EFFORT_SQL="effort"
case "$EFFORT" in low|medium|high) EFFORT_SQL="'${EFFORT}'" ;; esac
SESSION_SQL="NULL"
[ -n "$SESSION_ID" ] && SESSION_SQL="'$(tmb_sql_quote "$SESSION_ID")'"
MODEL_SQL="NULL"
[ -n "$MODEL" ] && MODEL_SQL="'$(tmb_sql_quote "$MODEL")'"
NOW=$(tmb_now_iso)

tmb_db_write "$DB" "
UPDATE agent_runs
   SET completed_at = '${NOW}',
       exit_reason = 'swept_orphan',
       ${TMB_RUN_UNMEASURED_SQL},
       duration_ms = CASE WHEN duration_ms = 0
                          THEN COALESCE(CAST(ROUND((julianday('${NOW}') - julianday(started_at)) * 86400000) AS INTEGER), 0)
                          ELSE duration_ms END
 WHERE task_id = ${SAFE_TASK_ID} AND agent_type = 'swe' AND completed_at IS NULL
   AND (spawn_id IS NULL OR spawn_id GLOB 'tool_use:*')
   AND started_at IS NOT NULL AND started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 seconds');
UPDATE tasks SET status = 'running', updated_at = '${NOW}', completed_at = NULL
 WHERE id = ${SAFE_TASK_ID} AND status = 'pending';
INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at, repo, root_dir, host,
                        session_id, effort, model, spawn_id)
SELECT id, issue_id, 'swe', '${NOW}', repo, ${ROOT_DIR_SQL}, 'claude',
       ${SESSION_SQL}, ${EFFORT_SQL}, ${MODEL_SQL}, '$(tmb_sql_quote "$SPAWN_ID")'
  FROM tasks WHERE id = ${SAFE_TASK_ID};" >/dev/null 2>&1 || true

exit 0
