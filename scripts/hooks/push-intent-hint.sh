#!/usr/bin/env bash
# UserPromptSubmit hook. When the user's prompt expresses *push intent*
# ("git push", "push it", "push the work", "ship it"), check the DB for
# `needs_validation` tasks on the current branch and inject context so
# bro spawns pr-reviewer BEFORE actually attempting the push.
#
# Captures L5/L6 row 7 — vague `@bro git push` should fire the full
# push chain (discover pending validation, spawn pr-reviewer, then push).
# Without this hint bro often interprets "git push" as a request to
# describe what push would do rather than executing the chain.
#
# Bypass: TMB_DISABLE_PUSH_INTENT_HINT=1.
# Always silent on failure; never blocks.

set -uo pipefail

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_PUSH_INTENT_HINT:-0}" = "1" ]; then
  exit 0
fi

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -n "$PROMPT" ] || exit 0

# Pattern detection — push intent. Precision over recall.
matched=""
for pat in \
  'git push' 'push it' 'push the work' 'push the branch' 'push the change' \
  'push up' 'push them up' 'push my work' 'ship it' 'ship the work' \
  'send it up' 'time to push'; do
  case "$PROMPT" in
    *"$pat"*)
      matched="$pat"
      break
      ;;
  esac
done

[ -n "$matched" ] || exit 0

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  dir="$PWD"
  for _ in 1 2 3 4 5 6 7 8; do
    candidate="$dir/.claude/$PLUGIN_NAME/trajectory.db"
    if [ -f "$candidate" ]; then DB_PATH="$candidate"; break; fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
  [ -z "$DB_PATH" ] && DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi
[ -f "$DB_PATH" ] || exit 0

# Find tasks awaiting pr-reviewer signoff — the substrate the push gate
# operates against. Includes `closed` (bro_atomic_close set it but
# pr-reviewer hasn't scored yet — the canonical "ready for push, signoff
# missing" state in the documented per-fix flow: SWE → V1/V2/V3 →
# bro_atomic_close → pr-reviewer → push) in addition to the upstream
# in-flight states.
PENDING=$(sqlite3 "$DB_PATH" "
  SELECT t.id || '|' || t.branch_id || '|' || substr(COALESCE(t.title, ''), 1, 60)
    FROM tasks t
   WHERE t.status IN ('needs_validation', 'completed', 'closed')
     AND t.commit_sha IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM validation_attempts v
        WHERE v.task_id = t.id
          AND v.verdict = 'pass'
     );
" 2>/dev/null || true)

if [ -z "$PENDING" ]; then
  # Nothing to gate; let bro proceed unimpeded.
  exit 0
fi

PENDING_COUNT=$(printf '%s\n' "$PENDING" | wc -l | tr -d ' ')
LIST=$(printf '%s\n' "$PENDING" | awk -F'|' '{ printf "  - task_id=%s  branch=%s  (%s)\n", $1, $2, $3 }')

REASON="🚦 push-intent hint: the user's prompt contains '${matched}'. ${PENDING_COUNT} task(s) await pr-reviewer signoff before push:

${LIST}

Before \`git push\`, spawn pr-reviewer for each pending task via \`Agent(subagent_type='pr-reviewer', isolation=)\` (no worktree — pr-reviewer reviews from the main checkout). On all-pass verdicts the push will clear the git-push-guard. If you skip this, the guard will deny the push and you'll have to redo the work anyway."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $reason
  }
}'

exit 0
