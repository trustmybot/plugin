#!/usr/bin/env bash
# PreToolUse hook (#181). Gates bro's `task_update_status(status='closed')`
# on file_registry having fresh summaries for every path the SWE commit
# touched. Forces bro to call `file_registry_update_summaries` AFTER reading
# SWE's diff during verification, BEFORE flipping the task to closed.
#
# Why: bro has the full task context (issue + spec + diff just verified) to
# write good summaries; SWE doesn't. Per #181 the responsibility moved from
# SWE's atomic close to bro's verification step. This hook makes the new
# ownership structural — bro can't close the task until summaries are fresh.
#
# Block conditions (all must be true):
#   1. Trajectory DB exists (TMB project)
#   2. tool is mcp__*__task_update_status
#   3. args.agent == 'bro'
#   4. args.status == 'closed'
#   5. The task's commit_sha is set
#   6. At least one file the commit touched is missing from file_registry OR
#      its summary is null OR its summary_updated_at is older than the task's
#      created_at (stale)
#
# Allow when:
#   - Any of the above is false
#   - Bypass: TMB_ALLOW_CLOSE_WITHOUT_SUMMARIES=1
#
# Silent no-op when DB / sqlite3 / git missing.

set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null)

case "$TOOL_NAME" in
  mcp__*trajectory-server__task_update_status) ;;
  *) exit 0 ;;
esac

if [ "${TMB_ALLOW_CLOSE_WITHOUT_SUMMARIES:-0}" = "1" ]; then
  exit 0
fi

AGENT=$(echo "$INPUT" | jq -r '.tool_input.agent // ""' 2>/dev/null)
STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // ""' 2>/dev/null)
TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // ""' 2>/dev/null)

[ "$AGENT" = "bro" ] || exit 0
[ "$STATUS" = "closed" ] || exit 0
[ -n "$TASK_ID" ] || exit 0

DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  REPO_ROOT_FOR_DB=$(git rev-parse --show-toplevel 2>/dev/null) || REPO_ROOT_FOR_DB="$PWD"
  DB_PATH="$REPO_ROOT_FOR_DB/.claude/$PLUGIN_NAME/trajectory.db"
fi

[ -f "$DB_PATH" ] || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0

ROW=$(sqlite3 -separator $'\x1f' "$DB_PATH" "SELECT commit_sha, created_at FROM tasks WHERE id=$TASK_ID LIMIT 1;" 2>/dev/null)
[ -n "$ROW" ] || exit 0

COMMIT_SHA="${ROW%%$'\x1f'*}"
CREATED_AT="${ROW#*$'\x1f'}"
[ -n "$COMMIT_SHA" ] || exit 0

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

if ! git -C "$REPO_ROOT" rev-parse --verify "$COMMIT_SHA" >/dev/null 2>&1; then
  exit 0
fi

TOUCHED=$(git -C "$REPO_ROOT" diff-tree --no-commit-id --name-only -r "$COMMIT_SHA" 2>/dev/null)
[ -n "$TOUCHED" ] || exit 0

MISSING=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  # Skip runtime state + dependency paths — never user-authored code.
  case "$path" in
    .claude/*|.git/*|node_modules/*|*/node_modules/*|dist/*|*/dist/*) continue ;;
  esac
  path_esc=${path//\'/\'\'}
  row_state=$(sqlite3 -separator $'\x1f' "$DB_PATH" "SELECT
    CASE
      WHEN summary IS NULL OR summary = '' THEN 'no-summary'
      WHEN summary_updated_at IS NULL THEN 'no-summary-ts'
      WHEN summary_updated_at < '$CREATED_AT' THEN 'stale-summary'
      ELSE 'ok'
    END
  FROM file_registry WHERE path='$path_esc' LIMIT 1;" 2>/dev/null)
  if [ -z "$row_state" ]; then
    MISSING="$MISSING\n  - $path (no file_registry row)"
  elif [ "$row_state" != "ok" ]; then
    MISSING="$MISSING\n  - $path ($row_state)"
  fi
done <<< "$TOUCHED"

[ -n "$MISSING" ] || exit 0

REASON=$(printf "BLOCKED: cannot close task #%s — file_registry has missing or stale summaries for paths SWE touched in commit %s:%b\n\nCall file_registry_update_summaries(agent='bro', updates=[{path, summary: '<your fresh summary based on the diff you just verified>'}, ...], advance_verified_sha='%s') BEFORE task_update_status(closed). Per #181, summary authorship belongs to bro (full task context); SWE doesn't get to write them. Bypass: TMB_ALLOW_CLOSE_WITHOUT_SUMMARIES=1." \
  "$TASK_ID" "$COMMIT_SHA" "$MISSING" "$COMMIT_SHA")

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
