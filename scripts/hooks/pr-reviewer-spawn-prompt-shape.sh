#!/usr/bin/env bash
# PreToolUse hook on Agent. Validates that pr-reviewer spawns include the
# required prompt fields: task_id=<N> and subagent_session_id.
#
# pr-reviewer.md contract: "Spawn input: task_id=<N> and your
# subagent_session_id. Reject if task_id is missing." This hook enforces
# the bro-side of that contract — bro must include both fields when spawning
# pr-reviewer. A spawn without task_id or subagent_session_id leaves pr-reviewer
# unable to load the spec or record a valid validation_record verdict.
#
# Bypass: TMB_ALLOW_PR_REVIEWER_SHAPE_SKIP=1 (emergency / test use only).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if [ "${TMB_ALLOW_PR_REVIEWER_SHAPE_SKIP:-0}" = "1" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Agent" ] || exit 0

SUBAGENT=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""' 2>/dev/null)")
[ "$SUBAGENT" = "pr-reviewer" ] || exit 0

PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null)

HAS_TASK_ID=""
HAS_SESSION_ID=""

case "$PROMPT" in
  *"task_id="*) HAS_TASK_ID="yes" ;;
esac

case "$PROMPT" in
  *"subagent_session_id"*) HAS_SESSION_ID="yes" ;;
esac

if [ -z "$HAS_TASK_ID" ] || [ -z "$HAS_SESSION_ID" ]; then
  MISSING=""
  [ -z "$HAS_TASK_ID" ] && MISSING="task_id=<N>"
  if [ -z "$HAS_SESSION_ID" ]; then
    [ -n "$MISSING" ] && MISSING="$MISSING and subagent_session_id" || MISSING="subagent_session_id"
  fi

  REASON="pr-reviewer spawn is missing required prompt field(s): ${MISSING}.

pr-reviewer.md contract: spawn must include task_id=<N> and subagent_session_id. Without task_id, pr-reviewer cannot load the spec. Without subagent_session_id, validation_record will be rejected by the server (precondition_failed).

Add both fields to the prompt and retry. For exceptional override, set TMB_ALLOW_PR_REVIEWER_SHAPE_SKIP=1."

  jq -nc --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
fi

exit 0
