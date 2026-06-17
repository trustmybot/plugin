#!/usr/bin/env bash
# PostToolUse hook on Skill. Writes one row to skill_invocations every time
# the user (or an agent) invokes a Skill via the Skill tool. Closes the
# "did this agent use the skill it should have" detection loop (#2886).
#
# Schema-side prereqs (MR B): the cheatcodes registry has the builtin skill
# catalog row (#101); agent_runs has bro's open row for the current task;
# skill_invocations is the junction.
#
# Resolution:
# - skill_name: from tool_input.skill (Skill tool's required arg)
# - agent_name: defaults to 'bro' (main Claude session). Subagent hook
#   invocations are not captured here (subagents have their own session).
# - agent_run_id: latest open bro row in agent_runs (completed_at IS NULL).
#   NULL when bro has no active task (e.g., onboarding, /scan-only sessions).
# - task_id: derived from the open bro row (NULL when no row).
#
# Failure modes are silent — this hook is analytics, never load-bearing.
# Bypass: TMB_DISABLE_SKILL_INVOCATION_HOOK=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_SKILL_INVOCATION_HOOK:-0}" = "1" ]; then
  exit 0
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)
[ "$TOOL_NAME" = "Skill" ] || exit 0

# Only record skill invocations from the bro session. Subagents (swe,
# pr-reviewer) have their own sessions and are excluded by design.
HOOK_AGENT=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // ""' 2>/dev/null)")
[ -z "$HOOK_AGENT" ] || [ "$HOOK_AGENT" = "bro" ] || exit 0

SKILL_NAME=$(echo "$INPUT" | jq -r '.tool_input.skill // ""' 2>/dev/null)
[ -n "$SKILL_NAME" ] || exit 0
# CC delivers skill names with a plugin prefix (e.g. "tmb:tmb_planning").
# The cheatcodes catalog stores bare names ("tmb_planning"). Strip the prefix.
SKILL_NAME="${SKILL_NAME#*:}"

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0

# Confirm the skill exists in the catalog — a builtin skill row in the unified
# cheatcodes registry (#101). If not, skip silently — this is either an
# unrelated tool with the same name or a project-local skill not yet registered.
SKILL_NAME_SQL=$(tmb_sql_quote "$SKILL_NAME")
EXISTS=$(sqlite3 "$DB_PATH" \
  "SELECT 1 FROM cheatcodes WHERE name = '${SKILL_NAME_SQL}' AND kind = 'skill' AND origin = 'builtin' LIMIT 1;" 2>/dev/null)
[ "$EXISTS" = "1" ] || exit 0

# Find the most recent open bro agent_run (if any) to attribute the
# invocation to. Mainline assumption: the bro session has an open run
# for the current task. If onboarding (no task), agent_run_id stays NULL.
RUN_ROW=$(sqlite3 -separator '|' "$DB_PATH" \
  "SELECT id, task_id FROM agent_runs WHERE agent_type = 'bro' AND completed_at IS NULL ORDER BY id DESC LIMIT 1;" 2>/dev/null)
RUN_ID="${RUN_ROW%%|*}"
TASK_ID="${RUN_ROW##*|}"
[ -n "$RUN_ID" ] || RUN_ID="NULL"
[ -n "$TASK_ID" ] || TASK_ID="NULL"
# When no row exists at all, both are empty after the split; normalize.
[ "$RUN_ROW" = "" ] && { RUN_ID="NULL"; TASK_ID="NULL"; }

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
# Escape single quotes in skill name for SQL literal safety (skill names
# are kebab/snake but defensive in case of a typo'd project-local skill).
SKILL_SQL=$(printf "%s" "$SKILL_NAME" | sed "s/'/''/g")

sqlite3 "$DB_PATH" \
  "INSERT INTO skill_invocations (skill_name, agent_name, agent_run_id, task_id, invoked_at, outcome)
   VALUES ('$SKILL_SQL', 'bro', $RUN_ID, $TASK_ID, '$NOW', 'completed');" 2>/dev/null || true

exit 0
