#!/usr/bin/env bash
# PreToolUse hook on Agent. Enforces the doctrine that pr-reviewer spawn
# happens AFTER bro_atomic_close: the task referenced by task_id=N in the
# spawn prompt must have status='closed' in the trajectory DB.
#
# Doctrine source: feedback_pr_reviewer_required_pre_push memory + planning
# skill Step 5.5 — "After bro_atomic_close succeeds, BEFORE pushing the
# branch, spawn pr-reviewer". The order is non-negotiable: bro_atomic_close
# is the in-DB closure that produces the artifact pr-reviewer evaluates.
#
# Non-deterministic bro flakiness has shipped CI runs where bro inferred
# "SWE completed and closed the task" from SWE's status return and skipped
# straight to pr-reviewer — leaving the task open + no verification audit.
# Structural enforcement here removes the failure mode without touching
# any prompt (prompt-freeze doctrine during auto-solve).
#
# Bypass: TMB_SKIP_PR_REVIEWER_CLOSE_GATE=1 (for tests that intentionally
# spawn pr-reviewer outside the close flow).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

if [ "${TMB_SKIP_PR_REVIEWER_CLOSE_GATE:-0}" = "1" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Agent" ] || exit 0

SUBAGENT=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.tool_input.subagent_type // ""' 2>/dev/null)")
[ "$SUBAGENT" = "pr-reviewer" ] || exit 0

PROMPT=$(echo "$INPUT" | jq -r '.tool_input.prompt // ""' 2>/dev/null)
TASK_ID=$(printf '%s' "$PROMPT" | grep -Eo 'task_id[[:space:]]*=[[:space:]]*[0-9]+' | head -1 | grep -Eo '[0-9]+' | head -1)

# No task_id in prompt? prompt-shape hook will catch it; not our concern.
[ -n "$TASK_ID" ] || exit 0

DB=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB" ] && [ -f "$DB" ] || exit 0

STATUS=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE id = $TASK_ID;" 2>/dev/null || true)

# Task not found? Don't block — let pr-reviewer surface the error itself.
[ -n "$STATUS" ] || exit 0

if [ "$STATUS" = "closed" ]; then
  exit 0
fi

REASON=$(jq -Rn --arg id "$TASK_ID" --arg st "$STATUS" '
  "BLOCKED: pr-reviewer spawn requires task " + $id + " status=closed but actual status=" + $st + ".\n\nPer planning skill Step 5.5 + feedback_pr_reviewer_required_pre_push doctrine, the order is:\n  1. SWE returns status=completed (lifecycle answer, NOT a DB closure).\n  2. bro runs V1 (task_get + git diff), V2 (3 checks), V3 (bro_atomic_close).\n  3. ONLY THEN: spawn pr-reviewer for the push gate.\n\nSWE returning completed does not close the trajectory task — that is bro_atomic_close.\n\nFix: call bro_atomic_close(agent='\''bro'\'', task_id=" + $id + ", commit_sha=<sha>, file_summaries=[...], verification_summary='\''...'\'') first, then retry this spawn."
')
printf '{"decision":"block","reason":%s}\n' "$REASON"
exit 0
