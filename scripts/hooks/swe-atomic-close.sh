#!/usr/bin/env bash
# SubagentStop hook — atomic-close safety net for SWE tasks (#87).
#
# When a SWE subagent stops, this hook locates the most-recent task in any
# terminal-eligible status (pending, needs_validation, completed), inspects
# git state, and either auto-closes a pending task or records metrics-only
# for tasks already flipped by the SWE workspace override.
#
# Fires on: SubagentStop
# Target: <1s wall time.
#
# Decision matrix:
#   pending           + HAS_COMMITS=true  → write status='completed' + commit_sha; write agent_runs; log
#   pending           + HAS_COMMITS=false → emit additionalContext warning; write agent_runs; log
#   needs_validation  + *                 → metrics-only; write agent_runs; status unchanged
#   completed         + *                 → metrics-only; write agent_runs; status unchanged
#   subagent_type != swe                  → silent exit 0
#
# Log: ${HOME}/.claude/<plugin-name>/logs/mcp-health.log (JSONL, appended)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/resolve-plugin-name.sh
. "$SCRIPT_DIR/../lib/resolve-plugin-name.sh"
PLUGIN_NAME=$(tmb_resolve_plugin_name)
# shellcheck source=scripts/hooks/lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || true
# shellcheck source=scripts/hooks/lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh" 2>/dev/null || true

mkdir -p "${HOME}/.claude/${PLUGIN_NAME}/logs" 2>/dev/null || true

# Parse a JSONL transcript file and return pipe-separated stats:
#   tokens_in|tokens_out|tool_uses|duration_ms
# On any error or missing file, prints 0|0|0|0.
tmb_parse_transcript_stats() {
  local transcript_path="$1"
  if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
    echo "0|0|0|0"
    return 0
  fi
  local result
  result=$(jq -rsc '
    (map(select(.message.usage != null) | .message.usage.input_tokens // 0) | add // 0) as $ti |
    (map(select(.message.usage != null) | .message.usage.output_tokens // 0) | add // 0) as $to |
    (map(.message.content // [] | arrays | .[]) | map(select(.type == "tool_use")) | length) as $tu |
    ( map(select(.timestamp != null) |
        .timestamp |
        capture("(?<sec>[^.]+)(?:\\.(?<ms>[0-9]+))?Z$") |
        ((.sec + "Z") | fromdateiso8601) * 1000 + ((.ms // "0")[0:3] | tonumber)
      ) |
      if length < 2 then 0 else (max - min) end
    ) as $dm |
    [$ti, $to, $tu, $dm] | join("|")
  ' "$transcript_path" 2>/dev/null) || true
  if [ -z "$result" ]; then
    echo "0|0|0|0"
  else
    echo "$result"
  fi
}

INPUT=$(cat)

# Diagnostic entry-log (#94): record every invocation regardless of subagent_type
# so we can separate "hook ran at all" from "hook decided X".
ENTRY_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ENTRY_KEYS=$(echo "$INPUT" | jq -rc '[paths(scalars) | join(".")] | unique // []' 2>/dev/null || echo '[]')
ENTRY_AGENT=$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)
printf '{"ts":"%s","kind":"swe-atomic-close-entry","keys":%s,"agent_type_resolved":"%s"}\n' \
  "$ENTRY_TS" "$ENTRY_KEYS" "$ENTRY_AGENT" \
  >> "${HOME}/.claude/${PLUGIN_NAME}/logs/mcp-health.log" || true

# Only act on SWE subagent stops.
AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")
if [ "$AGENT_TYPE" != "swe" ]; then
  exit 0
fi

# Resolve trajectory DB path (same logic as mcp-health-check.sh / query-task.sh).
# Walk up from PWD to handle workspace-pattern projects where the live DB
# lives at the workspace root above the inner repos (#2872 same root cause —
# the production agent_runs=0 symptom traces here).
DB=""
if command -v tmb_db_path >/dev/null 2>&1; then
  DB=$(tmb_db_path 2>/dev/null || true)
fi
if [ -z "$DB" ]; then
  # P0 guard: never traverse INTO the user's HOME from a descendant cwd.
  # Project state must not escape into the user's profile (mirrors db.ts).
  dir="$PWD"
  for _ in 1 2 3 4 5 6 7 8; do
    if [ "$dir" = "$HOME" ] && [ "$PWD" != "$HOME" ]; then
      break
    fi
    candidate="$dir/.claude/$PLUGIN_NAME/trajectory.db"
    if [ -f "$candidate" ]; then DB="$candidate"; break; fi
    parent=$(dirname "$dir")
    [ "$parent" = "$dir" ] && break
    dir="$parent"
  done
fi

if [ -z "$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# Read pr_target from config (default: main).
PR_TARGET=$(tmb_config_get "pr_target" 2>/dev/null || true)
PR_TARGET="${PR_TARGET:-main}"

# Find the most-recent task in any SWE-relevant status. parent_branch_id is
# needed to detect commits in the attached-worktree model (branch ref and
# worktree HEAD advance together; we compare HEAD against the parent branch).
# tasks.repo (added in MR !122) tells us which inner repo this task belongs
# to in workspace-pattern projects; resolve via repos.path.
ROW=$(sqlite3 "$DB" \
  "SELECT id, status, branch_id, COALESCE(parent_branch_id, ''), COALESCE(repo, '') FROM tasks
   WHERE status IN ('pending', 'needs_validation', 'completed')
   ORDER BY updated_at DESC, id DESC LIMIT 1;" \
  2>/dev/null || true)

if [ -z "$ROW" ]; then
  exit 0
fi

TASK_ID=$(echo "$ROW" | cut -d'|' -f1)
TASK_STATUS=$(echo "$ROW" | cut -d'|' -f2)
BRANCH=$(echo "$ROW" | cut -d'|' -f3)
PARENT_BRANCH=$(echo "$ROW" | cut -d'|' -f4)
TASK_REPO=$(echo "$ROW" | cut -d'|' -f5)

# Resolve REPO_ROOT for worktree path:
#   1. If task has a repo and repos.path resolves, use it (multi-repo workspace).
#   2. Else fall back to `git rev-parse --show-toplevel` from PWD.
#   3. Else PWD itself.
REPO_ROOT=""
if [ -n "$TASK_REPO" ]; then
  REPO_ROOT=$(sqlite3 "$DB" \
    "SELECT path FROM repos WHERE name='$(echo "$TASK_REPO" | sed "s/'/''/g")' LIMIT 1;" \
    2>/dev/null || true)
fi
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
fi

# Derive the worktree path: slug = everything after the last '/' in branch_id.
SLUG="${BRANCH##*/}"
WT_PATH="${REPO_ROOT}/.claude/worktrees/${SLUG}"

# Read the SWE's worktree HEAD.
WT_HEAD=$(git -C "$WT_PATH" rev-parse HEAD 2>/dev/null || true)

# HAS_COMMITS: SWE committed in the worktree.
#
# Attached-worktree model: SWE's commits advance the branch ref directly,
# so the worktree HEAD == the branch ref tip. Compare HEAD to the parent
# branch — if HEAD is ahead, SWE committed.
#
# Fallback (legacy DBs without parent_branch_id recorded): compare against
# the local branch ref. This catches the older detached-HEAD layout where
# worktree HEAD diverges from the branch ref.
HAS_COMMITS="false"
if [ -n "$WT_HEAD" ]; then
  if [ -n "$PARENT_BRANCH" ]; then
    PARENT_TIP=$(git -C "$REPO_ROOT" rev-parse "refs/heads/${PARENT_BRANCH}" 2>/dev/null || true)
    if [ -z "$PARENT_TIP" ]; then
      PARENT_TIP=$(git -C "$REPO_ROOT" rev-parse "refs/remotes/origin/${PARENT_BRANCH}" 2>/dev/null || true)
    fi
    if [ -n "$PARENT_TIP" ] && [ "$WT_HEAD" != "$PARENT_TIP" ]; then
      HAS_COMMITS="true"
    fi
  fi
  if [ "$HAS_COMMITS" = "false" ]; then
    LOCAL_FEATURE=$(git -C "$REPO_ROOT" rev-parse "refs/heads/${BRANCH}" 2>/dev/null || true)
    if [ -n "$LOCAL_FEATURE" ] && [ "$WT_HEAD" != "$LOCAL_FEATURE" ]; then
      HAS_COMMITS="true"
    fi
  fi
fi

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DECISION=""
CONTEXT=""

if [ "$TASK_STATUS" = "pending" ]; then
  if [ "$HAS_COMMITS" = "true" ]; then
    # Auto-close: write status='completed' + commit_sha via sqlite3.
    DECISION="auto-completed"
    sqlite3 "$DB" \
      "UPDATE tasks SET status='completed', commit_sha='${WT_HEAD}', updated_at=datetime('now'), completed_at=datetime('now') WHERE id=${TASK_ID};" \
      2>/dev/null || DECISION="auto-complete-failed"
  else
    # No commits in worktree beyond the local branch ref.
    DECISION="warn-no-commits"
    CONTEXT="SWE for task #${TASK_ID} stopped without committing in worktree at ${WT_PATH}. Bro should send SWE back or mark the task failed."
  fi
else
  # needs_validation or completed: SWE pre-flipped the status; capture metrics only.
  DECISION="metrics-only"
fi

# Always capture per-spawn resource metrics into agent_runs (#131, #137).
# CC's SubagentStop payload omits token/duration at the top level but
# DOES include agent_transcript_path — the JSONL with per-message usage.
# This never fails the hook — a diagnostic line is written on any parse error.
ISSUE_ID=$(sqlite3 "$DB" "SELECT issue_id FROM tasks WHERE id=${TASK_ID} LIMIT 1;" 2>/dev/null || true)
ISSUE_ID="${ISSUE_ID:-}"

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
TRANSCRIPT_PATH="${TRANSCRIPT_PATH:-}"

TOKENS_IN=0
TOKENS_OUT=0
TOOL_USES=0
DURATION_MS=0

if [ -n "$TRANSCRIPT_PATH" ]; then
  STATS=$(tmb_parse_transcript_stats "$TRANSCRIPT_PATH")
  if [ "$STATS" = "0|0|0|0" ] && [ ! -f "$TRANSCRIPT_PATH" ]; then
    printf '{"ts":"%s","kind":"agent-runs-stats-parse-failed","reason":"transcript file not found","transcript":"%s"}\n' \
      "$ts" "$TRANSCRIPT_PATH" >> "${HOME}/.claude/${PLUGIN_NAME}/logs/mcp-health.log" || true
  else
    TOKENS_IN=$(echo "$STATS" | cut -d'|' -f1)
    TOKENS_OUT=$(echo "$STATS" | cut -d'|' -f2)
    TOOL_USES=$(echo "$STATS" | cut -d'|' -f3)
    DURATION_MS=$(echo "$STATS" | cut -d'|' -f4)
    printf '{"ts":"%s","kind":"agent-runs-stats-parsed","task_id":%s,"tokens_total":%s,"tool_uses":%s,"duration_ms":%s,"transcript":"%s"}\n' \
      "$ts" "$TASK_ID" "$((TOKENS_IN + TOKENS_OUT))" "$TOOL_USES" "$DURATION_MS" "$TRANSCRIPT_PATH" \
      >> "${HOME}/.claude/${PLUGIN_NAME}/logs/mcp-health.log" || true
  fi
fi

# Sanitize: ensure all values are integers (default 0 if not)
TOKENS_IN=$(printf '%d' "${TOKENS_IN}" 2>/dev/null || echo "0")
TOKENS_OUT=$(printf '%d' "${TOKENS_OUT}" 2>/dev/null || echo "0")
TOOL_USES=$(printf '%d' "${TOOL_USES}" 2>/dev/null || echo "0")
DURATION_MS=$(printf '%d' "${DURATION_MS}" 2>/dev/null || echo "0")

TOKENS_TOTAL=$((TOKENS_IN + TOKENS_OUT))

# Resolve issue_id column (NULL-safe).
if [ -n "$ISSUE_ID" ]; then
  AR_ISSUE_FRAGMENT="${ISSUE_ID}"
else
  AR_ISSUE_FRAGMENT="NULL"
fi

AR_INSERT="INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, tool_uses, duration_ms, completed_at) VALUES (${TASK_ID}, ${AR_ISSUE_FRAGMENT}, '${AGENT_TYPE}', ${TOKENS_IN}, ${TOKENS_OUT}, ${TOKENS_TOTAL}, ${TOOL_USES}, ${DURATION_MS}, datetime('now'));"
sqlite3 "$DB" "$AR_INSERT" 2>/dev/null || \
  printf '{"ts":"%s","kind":"agent-runs-capture-skipped","reason":"sqlite3 insert failed","task_id":%s}\n' \
    "$ts" "$TASK_ID" >> "${HOME}/.claude/${PLUGIN_NAME}/logs/mcp-health.log" || true

# Log the decision.
if [ "$DECISION" = "auto-completed" ] || [ "$DECISION" = "auto-complete-failed" ]; then
  printf '{"ts":"%s","kind":"swe-atomic-close","task_id":%s,"branch":"%s","decision":"%s","commit_sha":"%s"}\n' \
    "$ts" "$TASK_ID" "$BRANCH" "$DECISION" "$WT_HEAD" \
    >> "${HOME}/.claude/${PLUGIN_NAME}/logs/mcp-health.log" || true
else
  printf '{"ts":"%s","kind":"swe-atomic-close","task_id":%s,"branch":"%s","decision":"%s","worktree":"%s"}\n' \
    "$ts" "$TASK_ID" "$BRANCH" "$DECISION" "$WT_PATH" \
    >> "${HOME}/.claude/${PLUGIN_NAME}/logs/mcp-health.log" || true
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
