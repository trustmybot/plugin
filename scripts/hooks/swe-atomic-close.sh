#!/usr/bin/env bash
# SubagentStop hook — atomic-close safety net for SWE tasks (#87).
#
# When a SWE subagent stops, this hook checks whether the task it was running
# is still in 'pending' status. If yes, it inspects git state and either
# auto-closes the task (worktree has commits beyond the local feature ref) or
# emits an additionalContext warning to bro (no worktree commits).
#
# Fires on: SubagentStop
# Target: <1s wall time.
#
# Decision matrix:
#   pending + HAS_COMMITS=true  → write status='completed' + commit_sha via sqlite3; log
#   pending + HAS_COMMITS=false → emit additionalContext warning; log
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
ENTRY_AGENT=$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)
printf '{"ts":"%s","kind":"swe-atomic-close-entry","keys":%s,"agent_type_resolved":"%s"}\n' \
  "$ENTRY_TS" "$ENTRY_KEYS" "$ENTRY_AGENT" \
  >> "${HOME}/.claude/tmb/logs/mcp-health.log" || true

# Only act on SWE subagent stops.
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)
if [ "$AGENT_TYPE" != "swe" ] && [ "$AGENT_TYPE" != "tmb:swe" ]; then
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

# Find the most-recent pending task by scanning the DB for the worktree.
# SWE runs in a detached-HEAD worktree; `git rev-parse --abbrev-ref HEAD`
# returns "HEAD" not the branch name. Instead we look up by worktree path.
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0

# Read pr_target from config (default: main).
PR_TARGET=$(tmb_config_get "pr_target" 2>/dev/null || true)
PR_TARGET="${PR_TARGET:-main}"

# Find the most-recent pending SWE task.
ROW=$(sqlite3 "$DB" \
  "SELECT id, status, branch_id FROM tasks WHERE status='pending' ORDER BY id DESC LIMIT 1;" \
  2>/dev/null || true)

if [ -z "$ROW" ]; then
  exit 0
fi

TASK_ID=$(echo "$ROW" | cut -d'|' -f1)
TASK_STATUS=$(echo "$ROW" | cut -d'|' -f2)
BRANCH=$(echo "$ROW" | cut -d'|' -f3)

if [ "$TASK_STATUS" != "pending" ]; then
  exit 0
fi

# Derive the worktree path: slug = everything after the last '/' in branch_id.
SLUG="${BRANCH##*/}"
WT_PATH="${REPO_ROOT}/.claude/worktrees/${SLUG}"

# Read the SWE's worktree HEAD (works for detached HEAD).
WT_HEAD=$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || true)

# Read the local feature branch ref (what bro last reaped, if anything).
LOCAL_FEATURE=$(git -C "$REPO_ROOT" rev-parse "refs/heads/${BRANCH}" 2>/dev/null || true)

# HAS_COMMITS: worktree has commits that haven't been reaped into local branch yet.
HAS_COMMITS="false"
if [ -n "$WT_HEAD" ] && [ "$WT_HEAD" != "$LOCAL_FEATURE" ]; then
  HAS_COMMITS="true"
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DECISION=""
CONTEXT=""

if [ "$HAS_COMMITS" = "true" ]; then
  # Auto-close: write status='completed' + commit_sha via sqlite3.
  DECISION="auto-completed"
  sqlite3 "$DB" \
    "UPDATE tasks SET status='completed', commit_sha='${WT_HEAD}', updated_at=datetime('now'), completed_at=datetime('now') WHERE id=${TASK_ID};" \
    2>/dev/null || DECISION="auto-complete-failed"

  # Capture per-spawn resource metrics into agent_runs (#131).
  # CC's SubagentStop payload does not yet expose token/duration fields;
  # we probe every known candidate and default to 0 for any missing field.
  # This never fails the hook — a diagnostic line is written on any parse error.
  ISSUE_ID=$(sqlite3 "$DB" "SELECT issue_id FROM tasks WHERE id=${TASK_ID} LIMIT 1;" 2>/dev/null || true)
  ISSUE_ID="${ISSUE_ID:-}"

  TOKENS_IN=$(echo "$INPUT" | jq -r '.total_input_tokens // .input_tokens // 0' 2>/dev/null || echo "0")
  TOKENS_OUT=$(echo "$INPUT" | jq -r '.total_output_tokens // .output_tokens // 0' 2>/dev/null || echo "0")
  TOKENS_TOTAL=$(echo "$INPUT" | jq -r '.total_tokens // 0' 2>/dev/null || echo "0")
  TOOL_USES=$(echo "$INPUT" | jq -r '.tool_use_count // 0' 2>/dev/null || echo "0")
  DURATION_MS=$(echo "$INPUT" | jq -r '.duration_ms // 0' 2>/dev/null || echo "0")

  # Sanitize: ensure all values are integers (default 0 if not)
  TOKENS_IN=$(printf '%d' "${TOKENS_IN}" 2>/dev/null || echo "0")
  TOKENS_OUT=$(printf '%d' "${TOKENS_OUT}" 2>/dev/null || echo "0")
  TOKENS_TOTAL=$(printf '%d' "${TOKENS_TOTAL}" 2>/dev/null || echo "0")
  TOOL_USES=$(printf '%d' "${TOOL_USES}" 2>/dev/null || echo "0")
  DURATION_MS=$(printf '%d' "${DURATION_MS}" 2>/dev/null || echo "0")

  # If total is 0 but in+out are known, derive total.
  if [ "$TOKENS_TOTAL" -eq 0 ] && [ "$((TOKENS_IN + TOKENS_OUT))" -gt 0 ]; then
    TOKENS_TOTAL=$((TOKENS_IN + TOKENS_OUT))
  fi

  # Resolve issue_id column (NULL-safe).
  if [ -n "$ISSUE_ID" ]; then
    AR_ISSUE_FRAGMENT="${ISSUE_ID}"
  else
    AR_ISSUE_FRAGMENT="NULL"
  fi

  AR_INSERT="INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, completed_at, exit_status) VALUES (${TASK_ID}, ${AR_ISSUE_FRAGMENT}, '${AGENT_TYPE}', ${TOKENS_IN}, ${TOKENS_OUT}, ${TOKENS_TOTAL}, ${TOOL_USES}, ${DURATION_MS}, datetime('now'), 'completed');"
  sqlite3 "$DB" "$AR_INSERT" 2>/dev/null || \
    printf '{"ts":"%s","kind":"agent-runs-capture-skipped","reason":"sqlite3 insert failed","task_id":%s}\n' \
      "$ts" "$TASK_ID" >> "${HOME}/.claude/tmb/logs/mcp-health.log" || true

  # Log decision.
  printf '{"ts":"%s","kind":"swe-atomic-close","task_id":%s,"branch":"%s","decision":"%s","commit_sha":"%s"}\n' \
    "$ts" "$TASK_ID" "$BRANCH" "$DECISION" "$WT_HEAD" \
    >> "${HOME}/.claude/tmb/logs/mcp-health.log" || true

else
  # No commits in worktree beyond the local branch ref.
  DECISION="warn-no-commits"
  CONTEXT="SWE for task #${TASK_ID} stopped without committing in worktree at ${WT_PATH}. Bro should send SWE back or mark the task failed."
fi

# Log warn decisions too.
if [ "$DECISION" = "warn-no-commits" ]; then
  printf '{"ts":"%s","kind":"swe-atomic-close","task_id":%s,"branch":"%s","decision":"%s","worktree":"%s"}\n' \
    "$ts" "$TASK_ID" "$BRANCH" "$DECISION" "$WT_PATH" \
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
