#!/usr/bin/env bash
# PreToolUse hook on Agent. Blocks pr-reviewer spawns whose prompt violates
# the spawn discipline from tmb_push-gate: MUST contain the six bare anchors
# (task_id, commit_sha, branch_id, repo, attempt_n, subagent_session_id) and
# MUST NOT contain prior-verdict shortcuts that allow rubber-stamping.
#
# Doctrine: the spawn prompt shape is a deterministic constraint — either the
# anchors are present or they aren't. "Don't rubber-stamp" is equally
# binary. Both are better enforced here than repeated in skill prose.
#
# Bypass: TMB_SKIP_PR_REVIEWER_PROMPT_SHAPE=1 (for tests that construct
# minimal prompts intentionally).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if [ "${TMB_SKIP_PR_REVIEWER_PROMPT_SHAPE:-0}" = "1" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Agent" ] || exit 0

SUBAGENT=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""' 2>/dev/null)")
[ "$SUBAGENT" = "pr-reviewer" ] || exit 0

PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null)

# Check required anchors
MISSING=""
for anchor in task_id commit_sha branch_id repo attempt_n subagent_session_id; do
  if ! echo "$PROMPT" | grep -q "${anchor}"; then
    MISSING="${MISSING} ${anchor}"
  fi
done

if [ -n "$MISSING" ]; then
  REASON=$(jq -Rn --arg missing "$MISSING" '
    "BLOCKED: pr-reviewer spawn prompt missing required anchors:" + $missing + ".\n\nPer tmb_push-gate, the prompt MUST contain task_id, commit_sha, branch_id, repo, attempt_n, and subagent_session_id so pr-reviewer can load context independently and author its validation_record verdict. Do not pre-summarize findings — pass only the bare anchors plus a one-line context summary."
  ')
  jq -nc --argjson r "$REASON" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
fi

# Check forbidden rubber-stamp phrases
RUBBER_STAMP_FOUND=""
while IFS= read -r phrase; do
  if echo "$PROMPT" | grep -qi "$phrase"; then
    RUBBER_STAMP_FOUND="$phrase"
    break
  fi
done <<'PHRASES'
trust the prior verdict
fast-track if
rubber.stamp
prior verdict
PHRASES

if [ -n "$RUBBER_STAMP_FOUND" ]; then
  REASON=$(jq -Rn --arg phrase "$RUBBER_STAMP_FOUND" '
    "BLOCKED: pr-reviewer spawn prompt contains a rubber-stamp shortcut (matched: \"" + $phrase + "\").\n\nPer tmb_push-gate, the prompt MUST NOT contain the prior verdict text or shortcuts that allow rubber-stamping. The reviewer must derive findings from the spec + diff itself."
  ')
  jq -nc --argjson r "$REASON" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
fi

exit 0
