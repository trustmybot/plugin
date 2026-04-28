#!/usr/bin/env bash
# SubagentStop hook — atomic-close safety net for SWE tasks (#87).
#
# When a SWE subagent stops, this hook checks whether the task it was running
# is still in 'pending' status. If yes, it inspects git state and either
# auto-closes the task (committed + pushed) or emits an additionalContext
# warning to bro (committed-not-pushed or no-commits).
#
# Fires on: SubagentStop
# Target: <1s wall time.
#
# Decision matrix:
#   pending + commits + pushed  → write status='completed' + commit_sha via sqlite3; log
#   pending + commits + no push → emit additionalContext warning; log
#   pending + no commits        → emit additionalContext warning; log
#   status != pending           → silent exit 0
#   subagent_type != swe        → silent exit 0
#
# Log: ${HOME}/.claude/tmb/logs/mcp-health.log (JSONL, appended)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || true

mkdir -p "${HOME}/.claude/tmb/logs" 2>/dev/null || true

INPUT=$(cat)

# Diagnostic entry-log (#94): record every invocation regardless of subagent_type
# so we can separate "hook ran at all" from "hook decided X".
ENTRY_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ENTRY_KEYS=$(echo "$INPUT" | jq -rc '[paths(scalars) | join(".")] | unique // []' 2>/dev/null || echo '[]')
ENTRY_AGENT=$(echo "$INPUT" | jq -r '.subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)
printf '{"ts":"%s","kind":"swe-atomic-close-entry","keys":%s,"agent_type_resolved":"%s"}\n' \
  "$ENTRY_TS" "$ENTRY_KEYS" "$ENTRY_AGENT" \
  >> "${HOME}/.claude/tmb/logs/mcp-health.log" || true

# Only act on SWE subagent stops.
AGENT_TYPE=$(echo "$INPUT" | jq -r '.subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)
if [ "$AGENT_TYPE" != "swe" ]; then
  exit 0
fi

# Resolve trajectory DB path (same logic as mcp-health-check.sh / query-task.sh).
DB=""
if command -v tmb_db_path >/dev/null 2>&1; then
  DB=$(tmb_db_path 2>/dev/null || true)
fi
if [ -z "$DB" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || REPO_ROOT="$(pwd)"
  CANDIDATE="$REPO_ROOT/.claude/$PLUGIN_NAME/trajectory.db"
  [ -f "$CANDIDATE" ] && DB="$CANDIDATE"
fi

if [ -z "$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# Find the most-recent pending task for the current branch.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0

if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  exit 0
fi

ROW=$(sqlite3 "$DB" \
  "SELECT id, status FROM tasks WHERE branch_id='${BRANCH}' ORDER BY id DESC LIMIT 1;" \
  2>/dev/null || true)

if [ -z "$ROW" ]; then
  exit 0
fi

TASK_ID=$(echo "$ROW" | cut -d'|' -f1)
TASK_STATUS=$(echo "$ROW" | cut -d'|' -f2)

if [ "$TASK_STATUS" != "pending" ]; then
  exit 0
fi

# Determine git state: any commits beyond merge-base with dev?
DEV_BASE=$(git -C "$REPO_ROOT" merge-base HEAD "origin/dev" 2>/dev/null \
  || git -C "$REPO_ROOT" merge-base HEAD "dev" 2>/dev/null \
  || git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null \
  || true)

LOCAL_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)

if [ -z "$LOCAL_HEAD" ]; then
  exit 0
fi

HAS_COMMITS="false"
if [ -n "$DEV_BASE" ] && [ "$DEV_BASE" != "$LOCAL_HEAD" ]; then
  HAS_COMMITS="true"
fi

# Check whether origin/<branch> matches local HEAD.
IS_PUSHED="false"
REMOTE_SHA=$(git -C "$REPO_ROOT" rev-parse "origin/${BRANCH}" 2>/dev/null || true)
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" = "$LOCAL_HEAD" ]; then
  IS_PUSHED="true"
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DECISION=""
CONTEXT=""

if [ "$HAS_COMMITS" = "true" ] && [ "$IS_PUSHED" = "true" ]; then
  # Auto-close: write status='completed' + commit_sha via sqlite3.
  DECISION="auto-completed"
  sqlite3 "$DB" \
    "UPDATE tasks SET status='completed', commit_sha='${LOCAL_HEAD}', updated_at=datetime('now'), completed_at=datetime('now') WHERE id=${TASK_ID};" \
    2>/dev/null || DECISION="auto-complete-failed"
  # Log decision.
  printf '{"ts":"%s","kind":"swe-atomic-close","task_id":%s,"branch":"%s","decision":"%s","commit_sha":"%s"}\n' \
    "$ts" "$TASK_ID" "$BRANCH" "$DECISION" "$LOCAL_HEAD" \
    >> "${HOME}/.claude/tmb/logs/mcp-health.log" || true

elif [ "$HAS_COMMITS" = "true" ]; then
  # Committed but not pushed.
  DECISION="warn-not-pushed"
  CONTEXT="SWE for task #${TASK_ID} committed but did not push. Branch ${BRANCH} at ${LOCAL_HEAD}. Bro should push or send SWE back."

else
  # No commits at all.
  DECISION="warn-no-commits"
  CONTEXT="SWE for task #${TASK_ID} stopped without committing. Branch ${BRANCH} is clean (no commits beyond dev). Bro should send SWE back or mark the task failed."
fi

# Log every non-auto-complete decision too.
if [ "$DECISION" != "auto-completed" ] && [ "$DECISION" != "auto-complete-failed" ]; then
  printf '{"ts":"%s","kind":"swe-atomic-close","task_id":%s,"branch":"%s","decision":"%s"}\n' \
    "$ts" "$TASK_ID" "$BRANCH" "$DECISION" \
    >> "${HOME}/.claude/tmb/logs/mcp-health.log" || true
fi

if [ -n "$CONTEXT" ]; then
  jq -nc --arg ctx "$CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "SubagentStop",
      additionalContext: $ctx
    }
  }'
fi

exit 0
