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
#   tokens_in|tokens_out|tool_uses|duration_ms|cache_read_tokens|cache_creation_tokens
# On any error or missing file, prints 0|0|0|0|0|0.
tmb_parse_transcript_stats() {
  local transcript_path="$1"
  if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
    echo "0|0|0|0|0|0"
    return 0
  fi
  local result
  result=$(jq -rsc '
    (map(select(.message.usage != null) | .message.usage.input_tokens // 0) | add // 0) as $ti |
    (map(select(.message.usage != null) | .message.usage.output_tokens // 0) | add // 0) as $to |
    (map(select(.message.usage != null) | .message.usage.cache_read_input_tokens // 0) | add // 0) as $cr |
    (map(select(.message.usage != null) | .message.usage.cache_creation_input_tokens // 0) | add // 0) as $cc |
    (map(.message.content // [] | arrays | .[]) | map(select(.type == "tool_use")) | length) as $tu |
    ( map(select(.timestamp != null) |
        .timestamp |
        capture("(?<sec>[^.]+)(?:\\.(?<ms>[0-9]+))?Z$") |
        ((.sec + "Z") | fromdateiso8601) * 1000 + ((.ms // "0")[0:3] | tonumber)
      ) |
      if length < 2 then 0 else (max - min) end
    ) as $dm |
    [$ti, $to, $tu, $dm, $cr, $cc] | join("|")
  ' "$transcript_path" 2>/dev/null) || true
  if [ -z "$result" ]; then
    echo "0|0|0|0|0|0"
  else
    echo "$result"
  fi
}

INPUT=$(cat)

# Rotate mcp-health.log at 1 MB (single .1 generation) to prevent unbounded growth (#389).
_LOG_FILE="${HOME}/.claude/${PLUGIN_NAME}/logs/mcp-health.log"
if [ -f "$_LOG_FILE" ] && [ "$(wc -c < "$_LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  mv -f "$_LOG_FILE" "${_LOG_FILE}.1" 2>/dev/null || true
fi

# Diagnostic entry-log (#94): record every invocation regardless of subagent_type
# so we can separate "hook ran at all" from "hook decided X".
ENTRY_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ENTRY_KEYS=$(echo "$INPUT" | jq -rc '[paths(scalars) | join(".")] | unique // []' 2>/dev/null || echo '[]')
ENTRY_AGENT=$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)
jq -cn --arg ts "$ENTRY_TS" --argjson keys "$ENTRY_KEYS" --arg agent "$ENTRY_AGENT" \
  '{ts:$ts,kind:"swe-atomic-close-entry",keys:$keys,agent_type_resolved:$agent}' \
  >> "$_LOG_FILE" 2>/dev/null || true

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

# Extract task_id from the subagent transcript (#369).
# When two SWEs run in parallel, the most-recently-updated task heuristic
# can auto-complete the WRONG task. The transcript contains the spawn prompt
# (first human turn) which includes `task_id=N`; prefer that over the
# updated_at sort.
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
TRANSCRIPT_PATH="${TRANSCRIPT_PATH:-}"

TRANSCRIPT_TASK_ID=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  TRANSCRIPT_TASK_ID=$(jq -r '
    .message.content // [] |
    .[] | select(.type == "text") | .text // ""
  ' "$TRANSCRIPT_PATH" 2>/dev/null \
    | grep -oE 'task_id=[0-9]+' | head -1 | sed 's/task_id=//' || true)
fi

# Derive worktree slug from input cwd (CC payload) or PWD structural fallback.
# Used by the slug-based task resolution when the transcript yields no task_id.
HOOK_CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || true)
HOOK_CWD="${HOOK_CWD:-$PWD}"
WORKTREE_ROOT=""
case "$HOOK_CWD" in
  */.claude/worktrees/*)
    WORKTREE_ROOT=$(echo "$HOOK_CWD" | sed -E 's|(.*/.claude/worktrees/[^/]+).*|\1|')
    ;;
esac

# Find the task to operate on:
#   1. task_id extracted from the transcript (authoritative — bound to this SWE).
#   2. Worktree slug match via branch_id LIKE '%/<slug>' (no transcript in this harness).
#   3. Most-recently-updated task in any SWE-relevant status (last-resort fallback).
ROW=""
if [ -n "$TRANSCRIPT_TASK_ID" ]; then
  SAFE_TRANSCRIPT_TASK_ID=$(tmb_sql_int "$TRANSCRIPT_TASK_ID")
  if [ -n "$SAFE_TRANSCRIPT_TASK_ID" ]; then
    ROW=$(sqlite3 "$DB" \
      "SELECT id, status, branch_id, COALESCE(parent_branch_id, ''), COALESCE(repo, '') FROM tasks
       WHERE id = ${SAFE_TRANSCRIPT_TASK_ID}
         AND status IN ('pending', 'needs_validation', 'completed')
       LIMIT 1;" \
      2>/dev/null || true)
  fi
fi
if [ -z "$ROW" ] && [ -n "$WORKTREE_ROOT" ]; then
  WORKTREE_SLUG=$(echo "$WORKTREE_ROOT" | sed -E 's|.*/.claude/worktrees/([^/]+)$|\1|')
  if [ -n "$WORKTREE_SLUG" ]; then
    SAFE_SLUG=$(tmb_sql_quote "$WORKTREE_SLUG")
    SLUG_ID=$(tmb_sqlite_ro "$DB" "
      SELECT id FROM tasks
       WHERE branch_id LIKE '%/${SAFE_SLUG}'
         AND status IN ('pending','running','completed')
       ORDER BY id DESC
       LIMIT 1;
    " 2>/dev/null || true)
    SLUG_ID=$(tmb_sql_int "$SLUG_ID")
    if [ -n "$SLUG_ID" ]; then
      ROW=$(sqlite3 "$DB" \
        "SELECT id, status, branch_id, COALESCE(parent_branch_id, ''), COALESCE(repo, '') FROM tasks
         WHERE id = ${SLUG_ID}
         LIMIT 1;" \
        2>/dev/null || true)
    fi
  fi
fi
if [ -z "$ROW" ]; then
  ROW=$(sqlite3 "$DB" \
    "SELECT id, status, branch_id, COALESCE(parent_branch_id, ''), COALESCE(repo, '') FROM tasks
     WHERE status IN ('pending', 'needs_validation', 'completed')
     ORDER BY updated_at DESC, id DESC LIMIT 1;" \
    2>/dev/null || true)
fi

if [ -z "$ROW" ]; then
  exit 0
fi

TASK_ID=$(echo "$ROW" | cut -d'|' -f1)
TASK_ID=$(tmb_sql_int "$TASK_ID")
[ -n "$TASK_ID" ] || exit 0
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
else
  # No-worktree fallback: SWE committed directly in REPO_ROOT on the feature
  # branch (e.g. planning skill's project-root path with "do not use worktrees").
  # Detect commits by comparing REPO_ROOT HEAD against parent_branch tip.
  ROOT_CURRENT_BRANCH=$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "$ROOT_CURRENT_BRANCH" = "$BRANCH" ] && [ -n "$PARENT_BRANCH" ]; then
    ROOT_HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)
    PARENT_TIP=$(git -C "$REPO_ROOT" rev-parse "refs/heads/${PARENT_BRANCH}" 2>/dev/null || true)
    if [ -z "$PARENT_TIP" ]; then
      PARENT_TIP=$(git -C "$REPO_ROOT" rev-parse "refs/remotes/origin/${PARENT_BRANCH}" 2>/dev/null || true)
    fi
    if [ -n "$ROOT_HEAD" ] && [ -n "$PARENT_TIP" ] && [ "$ROOT_HEAD" != "$PARENT_TIP" ]; then
      HAS_COMMITS="true"
      WT_HEAD="$ROOT_HEAD"
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
    SAFE_WT_HEAD=$(tmb_sql_quote "$WT_HEAD")
    sqlite3 "$DB" \
      "UPDATE tasks SET status='completed', commit_sha='${SAFE_WT_HEAD}', updated_at=datetime('now'), completed_at=datetime('now') WHERE id=${TASK_ID};" \
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
SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
ISSUE_ID=$(sqlite3 "$DB" "SELECT issue_id FROM tasks WHERE id=${SAFE_TASK_ID} LIMIT 1;" 2>/dev/null || true)
ISSUE_ID="${ISSUE_ID:-}"

# TRANSCRIPT_PATH already resolved above for task_id extraction.

TOKENS_IN=0
TOKENS_OUT=0
TOOL_USES=0
DURATION_MS=0
CACHE_READ_TOKENS=0
CACHE_CREATION_TOKENS=0

if [ -n "$TRANSCRIPT_PATH" ]; then
  STATS=$(tmb_parse_transcript_stats "$TRANSCRIPT_PATH")
  if [ "$STATS" = "0|0|0|0|0|0" ] && [ ! -f "$TRANSCRIPT_PATH" ]; then
    jq -cn --arg ts "$ts" --arg tr "$TRANSCRIPT_PATH" \
      '{ts:$ts,kind:"agent-runs-stats-parse-failed",reason:"transcript file not found",transcript:$tr}' \
      >> "$_LOG_FILE" 2>/dev/null || true
  else
    TOKENS_IN=$(echo "$STATS" | cut -d'|' -f1)
    TOKENS_OUT=$(echo "$STATS" | cut -d'|' -f2)
    TOOL_USES=$(echo "$STATS" | cut -d'|' -f3)
    DURATION_MS=$(echo "$STATS" | cut -d'|' -f4)
    CACHE_READ_TOKENS=$(echo "$STATS" | cut -d'|' -f5)
    CACHE_CREATION_TOKENS=$(echo "$STATS" | cut -d'|' -f6)
    jq -cn --arg ts "$ts" --argjson tid "$TASK_ID" \
      --argjson tt "$((TOKENS_IN + TOKENS_OUT))" \
      --argjson cr "$CACHE_READ_TOKENS" --argjson cc "$CACHE_CREATION_TOKENS" \
      --argjson tu "$TOOL_USES" --argjson dm "$DURATION_MS" \
      --arg tr "$TRANSCRIPT_PATH" \
      '{ts:$ts,kind:"agent-runs-stats-parsed",task_id:$tid,tokens_total:$tt,cache_read:$cr,cache_creation:$cc,tool_uses:$tu,duration_ms:$dm,transcript:$tr}' \
      >> "$_LOG_FILE" 2>/dev/null || true
  fi
fi

# Sanitize: ensure all values are integers (default 0 if not)
case "${TOKENS_IN}" in (''|*[!0-9]*) TOKENS_IN=0 ;; esac
case "${TOKENS_OUT}" in (''|*[!0-9]*) TOKENS_OUT=0 ;; esac
case "${TOOL_USES}" in (''|*[!0-9]*) TOOL_USES=0 ;; esac
case "${DURATION_MS}" in (''|*[!0-9]*) DURATION_MS=0 ;; esac
case "${CACHE_READ_TOKENS}" in (''|*[!0-9]*) CACHE_READ_TOKENS=0 ;; esac
case "${CACHE_CREATION_TOKENS}" in (''|*[!0-9]*) CACHE_CREATION_TOKENS=0 ;; esac

TOKENS_TOTAL=$((TOKENS_IN + TOKENS_OUT))

# Resolve issue_id column (NULL-safe, numeric-validated).
SAFE_ISSUE_ID=$(tmb_sql_int "$ISSUE_ID")
if [ -n "$SAFE_ISSUE_ID" ]; then
  AR_ISSUE_FRAGMENT="${SAFE_ISSUE_ID}"
else
  AR_ISSUE_FRAGMENT="NULL"
fi

SAFE_AGENT_TYPE=$(tmb_sql_quote "$AGENT_TYPE")
SAFE_AR_INSERT="INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, tokens_total, cache_read_tokens, cache_creation_tokens, tool_uses, duration_ms, completed_at) VALUES (${SAFE_TASK_ID}, ${AR_ISSUE_FRAGMENT}, '${SAFE_AGENT_TYPE}', ${TOKENS_IN}, ${TOKENS_OUT}, ${TOKENS_TOTAL}, ${CACHE_READ_TOKENS}, ${CACHE_CREATION_TOKENS}, ${TOOL_USES}, ${DURATION_MS}, datetime('now'));"
sqlite3 "$DB" "$SAFE_AR_INSERT" 2>/dev/null || \
  jq -cn --arg ts "$ts" --argjson tid "$TASK_ID" \
    '{ts:$ts,kind:"agent-runs-capture-skipped",reason:"agent_runs insert failed",task_id:$tid}' \
    >> "$_LOG_FILE" 2>/dev/null || true

# Log the decision.
if [ "$DECISION" = "auto-completed" ] || [ "$DECISION" = "auto-complete-failed" ]; then
  jq -cn --arg ts "$ts" --argjson tid "$TASK_ID" --arg br "$BRANCH" \
    --arg dec "$DECISION" --arg sha "$WT_HEAD" \
    '{ts:$ts,kind:"swe-atomic-close",task_id:$tid,branch:$br,decision:$dec,commit_sha:$sha}' \
    >> "$_LOG_FILE" 2>/dev/null || true
else
  jq -cn --arg ts "$ts" --argjson tid "$TASK_ID" --arg br "$BRANCH" \
    --arg dec "$DECISION" --arg wt "$WT_PATH" \
    '{ts:$ts,kind:"swe-atomic-close",task_id:$tid,branch:$br,decision:$dec,worktree:$wt}' \
    >> "$_LOG_FILE" 2>/dev/null || true
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
