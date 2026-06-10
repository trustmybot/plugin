#!/usr/bin/env bash
# UserPromptSubmit hook. When the user expresses *resume intent* ("keep
# going on X", "pick that up", "finish that work", "continue the X"),
# query the trajectory DB for the first actionable pending task and
# inject context so bro looks at THAT specific row before deciding to
# replan or do anything new.
#
# Captures L5/L6 row 12 — without this, bro on "let's keep going on the
# CLI entry-point work" with a cumulative DB containing multiple
# CLI-related issues replans from scratch instead of picking up the
# pre-seeded pending task that has a planning_complete audit.
#
# Bypass: TMB_DISABLE_RESUME_HINT=1.
# Always silent on failure; never blocks.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_RESUME_HINT:-0}" = "1" ]; then
  exit 0
fi

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -n "$PROMPT" ] || exit 0

# Resume intent. Precision-first; tolerate intermediate words.
matched=""
for pat in \
  'keep going' 'pick it up' 'pick that up' 'pick this up' 'pick up' \
  "let's continue" 'continue the work' 'continue with' 'resume' \
  'finish that' 'finish the' 'finish it' 'wrap that up' 'wrap up' \
  'still pending' 'still open' 'still waiting'; do
  case "$PROMPT" in
    *"$pat"*)
      matched="$pat"
      break
      ;;
  esac
done

[ -n "$matched" ] || exit 0

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0

# Find the most-recently-planned pending task — the canonical "what
# should I resume" target. Joins issues with planning_complete audits
# and pending tasks.
RESUME=$(sqlite3 -separator $'\x1f' "$DB_PATH" "
  SELECT
    t.id,
    t.issue_id,
    t.branch_id,
    substr(COALESCE(t.title, ''), 1, 60),
    substr(COALESCE(i.objective, ''), 1, 80)
  FROM tasks t
  JOIN issues i ON i.id = t.issue_id
  JOIN audit a ON a.issue_id = i.id AND a.event_type = 'planning_complete'
  WHERE t.status = 'pending'
    AND i.status = 'open'
  ORDER BY a.id DESC
  LIMIT 1;
" 2>/dev/null) || RESUME=""

[ -n "$RESUME" ] || exit 0

IFS=$'\x1f' read -r task_id issue_id branch_id title objective <<< "$RESUME"

REASON="↩️  resume-intent hint: the user's prompt contains '${matched}'. There's a pending task that already has \`planning_complete\` audit — resume that, do NOT create new tasks or replan.

  task_id=${task_id}
  issue_id=${issue_id}
  branch_id=${branch_id}
  title='${title}'
  issue.objective='${objective}'

Required workflow:
1. Call \`task_get(task_id=${task_id})\` to load the spec.
2. \`git switch ${branch_id}\` (or create from main if missing) and spawn SWE via \`Agent(subagent_type='swe')\` with the existing task_id.
3. Do NOT call \`issue_create\` or \`task_create_batch\` — replanning is forbidden when planning_complete already exists for this work."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $reason
  }
}'

exit 0
