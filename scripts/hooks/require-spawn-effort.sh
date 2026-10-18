#!/usr/bin/env bash
# PreToolUse hook on Agent, run by agent-spawn-dispatch.sh after
# require-task-spec.sh: the Agent call's `effort` must be the effort the
# trajectory DB holds for the spawn.
#
#   swe (subagent_type matching (^|:)swe$) whose prompt carries task_id=<N>:
#     tool_input.effort must equal tasks.effort of task N.
#   pr-reviewer (subagent_type matching (^|:)pr-reviewer$): tool_input.effort
#     must equal plugin_config.reviewer_effort (high when unset).
#   any other agent: allowed.
#
# A missing effort is a mismatch. The deny names the expected value and the
# fix. Without jq, or when the DB read fails, the spawn is denied
# (fail-closed; a DB that predates tasks.effort gets the restart-to-migrate
# remedy instead of the generic unavailable deny); with no trajectory DB (project not onboarded) or no sqlite3
# the gate allows, as every gate does. A swe prompt without a task id, or one
# naming no task row, is left to require-task-spec.sh.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || INPUT=""

if ! command -v jq >/dev/null 2>&1; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED: jq not found — TMB gate require-spawn-effort cannot decide without it, so the action is denied (fail-closed). Install jq (brew install jq, apt-get install jq), then retry."}}'
  exit 0
fi

SUBAGENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.subagent_type // ""' 2>/dev/null)
GIVEN=$(printf '%s' "$INPUT" | jq -r '.tool_input.effort // "" | tostring' 2>/dev/null)

deny_mismatch() {
  local who="$1" expected="$2" change="$3" given
  if [ -n "$GIVEN" ]; then given="passed effort=\"$GIVEN\""; else given="passed no effort"; fi
  jq -nc --arg r "BLOCKED: ${who} runs at effort \"${expected}\", but the Agent call ${given}. Pass effort=\"${expected}\" on the Agent call. ${change}" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
}

if [[ "$SUBAGENT" =~ (^|:)swe$ ]]; then
  PROMPT=$(printf '%s' "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null)
  TASK_ID=$(printf '%s' "$PROMPT" | grep -oE 'task_id[=:][[:space:]]*[0-9]+' | head -1 | grep -oE '[0-9]+' || true)
  SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
  [ -n "$SAFE_TASK_ID" ] || exit 0
  DB=$(tmb_db_path 2>/dev/null) || exit 0
  tmb_have_sqlite || exit 0
  EXPECTED=$(tmb_gate_read "$DB" "SELECT effort FROM tasks WHERE id = ${SAFE_TASK_ID};")
  if [ "$EXPECTED" = "__ERR__" ]; then
    HAS_EFFORT=$(tmb_gate_read "$DB" "SELECT name FROM pragma_table_info('tasks') WHERE name = 'effort';")
    if [ -z "$HAS_EFFORT" ]; then
      jq -nc --arg r "BLOCKED: the trajectory DB predates the typed-effort schema (tasks.effort is missing): the TMB plugin was updated but the MCP server has not migrated the DB yet. Restart Claude Code so the server migrates the DB, then retry the spawn." \
        '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
      exit 0
    fi
    tmb_deny_db_unavailable require-spawn-effort
    exit 0
  fi
  [ -n "$EXPECTED" ] || exit 0
  [ "$GIVEN" = "$EXPECTED" ] && exit 0
  deny_mismatch "task_id=${SAFE_TASK_ID} (tasks.effort)" "$EXPECTED" \
    "To run it at another effort, change the task first: task_reopen(task_id=${SAFE_TASK_ID}, effort=...) for rework, task_retry(effort=...) for a retry."
  exit 0
fi

if [[ "$SUBAGENT" =~ (^|:)pr-reviewer$ ]]; then
  DB=$(tmb_db_path 2>/dev/null) || exit 0
  tmb_have_sqlite || exit 0
  DEFAULTS=$(tmb_effort_defaults "$DB")
  if [ "$DEFAULTS" = "__ERR__" ] || [ -z "$DEFAULTS" ]; then
    tmb_deny_db_unavailable require-spawn-effort
    exit 0
  fi
  EXPECTED="${DEFAULTS#*|}"
  [ "$GIVEN" = "$EXPECTED" ] && exit 0
  deny_mismatch "pr-reviewer (plugin_config.reviewer_effort, high when unset)" "$EXPECTED" \
    "To change it for every review, config_set(key=\"reviewer_effort\", value=...)."
  exit 0
fi

exit 0
