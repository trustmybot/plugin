#!/usr/bin/env bash
# SubagentStop hook — atomic-close safety net + per-spawn metering for SWE,
# and per-spawn metering for pr-reviewer.
#
# Task binding: the `task_id=<N>` in the spawn prompt (tmb_task_id_from_transcript),
# for a task in any status. A swe transcript with no task id, or an id with no
# task row, writes one agent_runs_capture_skipped audit row and stops — the hook
# never guesses a task. An unbound pr-reviewer spawn stops silently.
#
# Fires on: SubagentStop
# Target: <1s wall time.
#
# Decision matrix (status side-effects, swe only):
#   pending + HAS_COMMITS=true  → status='completed' + commit_sha
#   pending + HAS_COMMITS=false → additionalContext warning to bro
#   any other status            → metrics only, status unchanged
#   subagent_type pr-reviewer   → metrics only
#   any other subagent_type     → silent exit 0
#
# Effort: a swe row copies tasks.effort of its task; a pr-reviewer row takes
# plugin_config.reviewer_effort (tmb_effort_defaults; high when unset). A
# pr-reviewer row is keyed by spawn_id alone, with root_dir the project root
# and exit_reason completed.
#
# Metering: the spawn's totals and dominant model from its transcript land on
# one agent_runs row (host claude, root_dir the task worktree when unset,
# exit_reason from the task's state once the spawn ended), keyed (task_id, spawn_id), spawn_id = the payload's agent_id, else the
# transcript path. The row task_brief opened for this spawn is UPDATEd
# (started_at preserved); with none, a complete row is INSERTed with started_at =
# the transcript's first timestamp. A re-fire for the same spawn updates in place.
#
# Log: <project>/.claude/<plugin-name>/logs/mcp-health.log (JSONL, appended);
# no log when the project has no TMB state dir.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/hooks/lib/query-task.sh disable=SC1091
. "$SCRIPT_DIR/lib/query-task.sh" 2>/dev/null || true
# shellcheck source=scripts/hooks/lib/normalize-role.sh disable=SC1091
. "$SCRIPT_DIR/lib/normalize-role.sh" 2>/dev/null || true
# shellcheck source=scripts/hooks/lib/resolve-repo.sh disable=SC1091
. "$SCRIPT_DIR/lib/resolve-repo.sh" 2>/dev/null || true
# shellcheck source=scripts/hooks/lib/db-write.sh disable=SC1091
. "$SCRIPT_DIR/lib/db-write.sh"

# Parse a JSONL transcript file and print pipe-separated stats:
#   tokens_in|tokens_out|tool_uses|duration_ms|cache_read_tokens|cache_creation_tokens|first_ts|model
# On a missing or unreadable file, prints 0|0|0|0|0|0|| (empty first_ts and model).
#
# Lines are grouped by message id (CC writes one line per content block, each
# repeating the message's usage; the last usage of a group wins; tool_uses
# counts every tool_use block). Every token column is a per-message sum — usage
# is billed per request, so these are the same units as bro rows. first_ts is
# the earliest timestamp normalized to 24-char ms-ISO. model is the dominant
# message.model (the one with the most tokens), restricted to
# [A-Za-z0-9._:@/[]-]; CC's synthetic messages (<synthetic>) carry no model.
tmb_parse_transcript_stats() {
  local transcript_path="$1"
  if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
    echo "0|0|0|0|0|0||"
    return 0
  fi
  local result
  result=$(jq -rsc '
    def ms:
      capture("^(?<sec>[^.]+?)(\\.(?<f>[0-9]+))?Z$")
      | ((.sec + "Z") | fromdateiso8601) * 1000 + (((.f // "") + "000")[0:3] | tonumber);
    def iso:
      if type == "string" then
        (capture("^(?<s>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.(?<f>[0-9]+))?Z$") // null)
        | if . == null then null else .s + "." + (((.f // "") + "000")[0:3]) + "Z" end
      else null end;
    def n: if type == "number" and . >= 0 then floor else 0 end;
    def model:
      if type == "string" and (startswith("<") | not) then gsub("[^A-Za-z0-9._:@/\\[\\]-]"; "") else "" end;
    ([.[] | .timestamp | iso | select(. != null)]) as $stamps |
    ( [ to_entries[] | .key as $i | .value
        | select(.message.usage != null)
        | {id: (.message.id // .uuid // ("line-" + ($i | tostring))), u: .message.usage, m: (.message.model | model)} ]
      | group_by(.id)
      | map({u: .[-1].u, m: .[-1].m}) ) as $msgs |
    ([.[] | .message.content // [] | arrays | .[] | select(.type == "tool_use")] | length) as $all_tu |
    ($msgs | map(.u.input_tokens | n) | add // 0) as $ti |
    ($msgs | map(.u.output_tokens | n) | add // 0) as $to |
    ($msgs | map(.u.cache_read_input_tokens | n) | add // 0) as $cr |
    ($msgs | map(.u.cache_creation_input_tokens | n) | add // 0) as $cc |
    ($stamps | map(ms) | if length < 2 then 0 else (max - min) end) as $dm |
    ( $msgs | map(select(.m != "")
              | {m, t: ([.u.input_tokens, .u.output_tokens, .u.cache_read_input_tokens, .u.cache_creation_input_tokens] | map(n) | add)})
      | group_by(.m) | map({m: .[0].m, t: (map(.t) | add)})
      | sort_by(-.t, .m) | .[0].m // "" ) as $model |
    [$ti, $to, $all_tu, $dm, $cr, $cc, ($stamps | min // ""), $model] | map(tostring) | join("|")
  ' "$transcript_path" 2>/dev/null) || true
  if [ -z "$result" ]; then
    echo "0|0|0|0|0|0||"
  else
    echo "$result"
  fi
}

INPUT=$(cat)

# Rotate mcp-health.log at 1 MB (single .1 generation) to prevent unbounded growth (#389).
_LOG_FILE=/dev/null
if _STATE_DIR=$(tmb_state_dir 2>/dev/null) && mkdir -p "$_STATE_DIR/logs" 2>/dev/null; then
  _LOG_FILE="$_STATE_DIR/logs/mcp-health.log"
fi
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

# Only act on swe and pr-reviewer subagent stops.
AGENT_TYPE=$(tmb_normalize_role "$(echo "$INPUT" | jq -r '.agent_type // .subagent_type // .tool_input.subagent_type // empty' 2>/dev/null || true)")
if [ "$AGENT_TYPE" != "swe" ] && [ "$AGENT_TYPE" != "pr-reviewer" ]; then
  exit 0
fi

DB=$(tmb_db_path 2>/dev/null || true)

if [ -z "$DB" ] || ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.agent_transcript_path // ""' 2>/dev/null || true)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || true)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || true)
SPAWN_ID="${AGENT_ID:-$TRANSCRIPT_PATH}"

TRANSCRIPT_TASK_ID=$(tmb_sql_int "$(tmb_task_id_from_transcript "$TRANSCRIPT_PATH")")
ROW=""
if [ -n "$TRANSCRIPT_TASK_ID" ]; then
  ROW=$(tmb_sqlite_ro "$DB" \
    "SELECT id, status, branch_id, COALESCE(parent_branch_id, ''), COALESCE(repo, ''), issue_id FROM tasks
      WHERE id = ${TRANSCRIPT_TASK_ID} LIMIT 1;")
fi

if [ -z "$ROW" ]; then
  [ "$AGENT_TYPE" = "swe" ] || exit 0
  SKIP_REASON="no task_id=<N> in the spawn transcript"
  [ -n "$TRANSCRIPT_TASK_ID" ] && SKIP_REASON="spawn transcript names task_id=${TRANSCRIPT_TASK_ID}, which has no task row"
  SKIP_JSON=$(jq -cn --arg tr "$TRANSCRIPT_PATH" --arg sp "$SPAWN_ID" --arg tid "$TRANSCRIPT_TASK_ID" --arg why "$SKIP_REASON" \
    '{reason:$why, transcript:$tr, spawn_id:$sp, task_id:(if $tid == "" then null else ($tid | tonumber) end)}')
  tmb_audit_append "$DB" -1 '' "hook:swe-atomic-close" "agent_runs_capture_skipped" \
    "SWE spawn not metered: ${SKIP_REASON}" "$SKIP_JSON" || true
  exit 0
fi

TASK_ID=$(echo "$ROW" | cut -d'|' -f1)
TASK_ID=$(tmb_sql_int "$TASK_ID")
[ -n "$TASK_ID" ] || exit 0
TASK_STATUS=$(echo "$ROW" | cut -d'|' -f2)
BRANCH=$(echo "$ROW" | cut -d'|' -f3)
PARENT_BRANCH=$(echo "$ROW" | cut -d'|' -f4)
TASK_REPO=$(echo "$ROW" | cut -d'|' -f5)
ISSUE_ID=$(echo "$ROW" | cut -d'|' -f6)

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Per-spawn metrics into agent_runs. A failed write is logged, never fatal.
STATS=$(tmb_parse_transcript_stats "$TRANSCRIPT_PATH")
IFS='|' read -r TOKENS_IN TOKENS_OUT TOOL_USES DURATION_MS CACHE_READ_TOKENS CACHE_CREATION_TOKENS FIRST_TS MODEL <<< "$STATS"
jq -cn --arg ts "$ts" --argjson tid "$TASK_ID" --arg tr "$TRANSCRIPT_PATH" --arg stats "$STATS" \
  '{ts:$ts,kind:"agent-runs-stats-parsed",task_id:$tid,stats:$stats,transcript:$tr}' \
  >> "$_LOG_FILE" 2>/dev/null || true

SAFE_TASK_ID=$(tmb_sql_int "$TASK_ID")
SAFE_ISSUE_ID=$(tmb_sql_int "$ISSUE_ID"); SAFE_ISSUE_ID=${SAFE_ISSUE_ID:-NULL}
SAFE_TOKENS_IN=$(tmb_sql_int "$TOKENS_IN"); SAFE_TOKENS_IN=${SAFE_TOKENS_IN:-0}
SAFE_TOKENS_OUT=$(tmb_sql_int "$TOKENS_OUT"); SAFE_TOKENS_OUT=${SAFE_TOKENS_OUT:-0}
SAFE_CACHE_READ_TOKENS=$(tmb_sql_int "$CACHE_READ_TOKENS"); SAFE_CACHE_READ_TOKENS=${SAFE_CACHE_READ_TOKENS:-0}
SAFE_CACHE_CREATION_TOKENS=$(tmb_sql_int "$CACHE_CREATION_TOKENS"); SAFE_CACHE_CREATION_TOKENS=${SAFE_CACHE_CREATION_TOKENS:-0}
SAFE_TOOL_USES=$(tmb_sql_int "$TOOL_USES"); SAFE_TOOL_USES=${SAFE_TOOL_USES:-0}
SAFE_DURATION_MS=$(tmb_sql_int "$DURATION_MS"); SAFE_DURATION_MS=${SAFE_DURATION_MS:-0}
SAFE_SPAWN_ID=$(tmb_sql_quote "$SPAWN_ID")
SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
SAFE_FIRST_TS=$(tmb_sql_quote "${FIRST_TS:-$(tmb_now_iso)}")
SAFE_SESSION_SQL="NULL"
[ -n "$SESSION_ID" ] && SAFE_SESSION_SQL="'$(tmb_sql_quote "$SESSION_ID")'"
SAFE_MODEL_SQL="NULL"
[ -n "${MODEL:-}" ] && SAFE_MODEL_SQL="'$(tmb_sql_quote "$MODEL")'"

# pr-reviewer: one metering row per spawn, effort = reviewer_effort; no task
# status side effects.
if [ "$AGENT_TYPE" = "pr-reviewer" ]; then
  REVIEWER_EFFORT_SQL="NULL"
  EFFORT_DEFAULTS=$(tmb_effort_defaults "$DB")
  case "${EFFORT_DEFAULTS#*|}" in
    low|medium|high) REVIEWER_EFFORT_SQL="'${EFFORT_DEFAULTS#*|}'" ;;
  esac
  SAFE_PROJECT_ROOT=$(tmb_sql_quote "$(cd "$(dirname "$DB")/../.." 2>/dev/null && pwd -P)")
  if ! tmb_db_write "$DB" "
UPDATE agent_runs
   SET tokens_in = ${SAFE_TOKENS_IN},
       tokens_out = ${SAFE_TOKENS_OUT},
       cache_read_tokens = ${SAFE_CACHE_READ_TOKENS},
       cache_creation_tokens = ${SAFE_CACHE_CREATION_TOKENS},
       tool_uses = ${SAFE_TOOL_USES},
       duration_ms = ${SAFE_DURATION_MS},
       completed_at = '${SAFE_NOW}',
       session_id = COALESCE(${SAFE_SESSION_SQL}, session_id),
       usage_source = 'subagent_stop',
       model = COALESCE(${SAFE_MODEL_SQL}, model),
       effort = COALESCE(effort, ${REVIEWER_EFFORT_SQL})
 WHERE task_id = ${SAFE_TASK_ID} AND agent_type = 'pr-reviewer' AND spawn_id = '${SAFE_SPAWN_ID}';
INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
                        repo, spawn_id, session_id, usage_source, model, host, root_dir, exit_reason, effort)
SELECT ${SAFE_TASK_ID}, ${SAFE_ISSUE_ID}, 'pr-reviewer', ${SAFE_TOKENS_IN}, ${SAFE_TOKENS_OUT}, ${SAFE_CACHE_READ_TOKENS},
       ${SAFE_CACHE_CREATION_TOKENS}, ${SAFE_TOOL_USES}, ${SAFE_DURATION_MS}, '${SAFE_FIRST_TS}', '${SAFE_NOW}',
       (SELECT repo FROM tasks WHERE id = ${SAFE_TASK_ID}), '${SAFE_SPAWN_ID}', ${SAFE_SESSION_SQL}, 'subagent_stop',
       ${SAFE_MODEL_SQL}, 'claude', '${SAFE_PROJECT_ROOT}', 'completed', ${REVIEWER_EFFORT_SQL}
 WHERE (SELECT changes()) = 0;"; then
    jq -cn --arg ts "$ts" --argjson tid "$TASK_ID" \
      '{ts:$ts,kind:"agent-runs-write-failed",task_id:$tid,agent_type:"pr-reviewer"}' \
      >> "$_LOG_FILE" 2>/dev/null || true
  fi
  exit 0
fi

# Resolve REPO_ROOT for worktree path:
#   1. If task has a repo and repos.path resolves, use it (multi-repo workspace).
#   2. Else fall back to `git rev-parse --show-toplevel` from PWD.
#   3. Else PWD itself.
REPO_ROOT=""
if [ -n "$TASK_REPO" ]; then
  # shellcheck disable=SC2001
  REPO_ROOT=$(sqlite3 "$DB" \
    "SELECT path FROM repos WHERE name='$(echo "$TASK_REPO" | sed "s/'/''/g")' LIMIT 1;" \
    2>/dev/null || true)
fi
if [ -z "$REPO_ROOT" ]; then
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")
fi

# Derive the worktree path: slug = everything after the last '/' in branch_id.
SLUG="${BRANCH##*/}"
# Resolve the worktree from the TASK'S REPO, repo-rooted, mirroring the creators
# (ensure-swe-worktree.sh / MCP task_provision) and swe-verification-gate.sh:
# the worktree lives at <repoRoot>/.claude/worktrees/<slug>. REPO_ROOT was
# resolved above from tasks.repo → repos.path (single-repo: repo == workspace).
WT_PATH="${REPO_ROOT}/.claude/worktrees/${SLUG}"

SAFE_ROOT_DIR=$(tmb_sql_quote "$WT_PATH")

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
    # Empty-parent_branch_id fallback: in the attached-worktree model SWE's
    # commits advance the feature ref directly, so WT_HEAD == refs/heads/<branch>
    # and the comparisons above never fire. Resolve the repo's base (its
    # repos.target_branch, else the repo default branch) and count commits the
    # worktree HEAD carries ahead of it.
    if [ "$HAS_COMMITS" = "false" ] && [ -z "$PARENT_BRANCH" ] && [ -n "$LOCAL_FEATURE" ] && [ "$WT_HEAD" = "$LOCAL_FEATURE" ]; then
      FALLBACK_BASE=""
      if command -v tmb_repo_resolve >/dev/null 2>&1; then
        # tmb_repo_resolve prints "target_branch|branching_model|protected_branches";
        # take only the first field (target_branch).
        FALLBACK_BASE=$(tmb_repo_resolve "$DB" "$REPO_ROOT" 2>/dev/null | head -1 | cut -d'|' -f1 || true)
      fi
      if [ -z "$FALLBACK_BASE" ] && command -v tmb_repo_default_branch >/dev/null 2>&1; then
        FALLBACK_BASE=$(tmb_repo_default_branch "$REPO_ROOT" 2>/dev/null || true)
      fi
      if [ -n "$FALLBACK_BASE" ]; then
        AHEAD=$(git -C "$WT_PATH" rev-list --count "origin/${FALLBACK_BASE}..HEAD" 2>/dev/null || true)
        if [ -z "$AHEAD" ]; then
          AHEAD=$(git -C "$WT_PATH" rev-list --count "${FALLBACK_BASE}..HEAD" 2>/dev/null || true)
        fi
        case "${AHEAD:-0}" in (''|*[!0-9]*) AHEAD=0 ;; esac
        if [ "${AHEAD:-0}" -gt 0 ]; then
          HAS_COMMITS="true"
        fi
      fi
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

DECISION=""
CONTEXT=""

if [ "$TASK_STATUS" = "pending" ]; then
  if [ "$HAS_COMMITS" = "true" ]; then
    # Auto-close: write status='completed' + commit_sha via sqlite3.
    DECISION="auto-completed"
    SAFE_WT_HEAD=$(tmb_sql_quote "$WT_HEAD")
    SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")
    SAFE_CLOSE_TASK_ID=$(tmb_sql_int "$TASK_ID")
    tmb_db_write "$DB" \
      "UPDATE tasks SET status='completed', commit_sha='${SAFE_WT_HEAD}', updated_at='${SAFE_NOW}', completed_at='${SAFE_NOW}' WHERE id=${SAFE_CLOSE_TASK_ID};" \
      || DECISION="auto-complete-failed"
  else
    # No commits in worktree beyond the local branch ref.
    DECISION="warn-no-commits"
    CONTEXT="SWE for task #${TASK_ID} stopped without committing in worktree at ${WT_PATH}. Bro should send SWE back or mark the task failed."
  fi
else
  # Any other status (running, failed, needs_validation, completed, ...): metrics only.
  DECISION="metrics-only"
fi

# exit_reason of the spawn's row: what the task looks like once the spawn ended.
case "$DECISION:$TASK_STATUS" in
  auto-completed:*|*:completed|*:closed|*:needs_validation) EXIT_REASON="completed" ;;
  *:escalated) EXIT_REASON="escalated" ;;
  *) EXIT_REASON="failed" ;;
esac

# One transaction: UPDATE this spawn's row — the one already keyed by spawn_id,
# else the unkeyed swe row task_brief opened inside this spawn — and INSERT a
# complete row only when nothing was updated.
if ! tmb_db_write "$DB" "
UPDATE agent_runs
   SET tokens_in = ${SAFE_TOKENS_IN},
       tokens_out = ${SAFE_TOKENS_OUT},
       cache_read_tokens = ${SAFE_CACHE_READ_TOKENS},
       cache_creation_tokens = ${SAFE_CACHE_CREATION_TOKENS},
       tool_uses = ${SAFE_TOOL_USES},
       duration_ms = ${SAFE_DURATION_MS},
       started_at = COALESCE(started_at, '${SAFE_FIRST_TS}'),
       completed_at = '${SAFE_NOW}',
       spawn_id = '${SAFE_SPAWN_ID}',
       session_id = COALESCE(${SAFE_SESSION_SQL}, session_id),
       usage_source = 'subagent_stop',
       model = COALESCE(${SAFE_MODEL_SQL}, model),
       host = COALESCE(host, 'claude'),
       root_dir = COALESCE(root_dir, '${SAFE_ROOT_DIR}'),
       exit_reason = COALESCE(exit_reason, '${EXIT_REASON}'),
       effort = COALESCE(effort, (SELECT effort FROM tasks WHERE id = ${SAFE_TASK_ID}))
 WHERE id = (
   SELECT id FROM agent_runs
    WHERE task_id = ${SAFE_TASK_ID}
      AND (spawn_id = '${SAFE_SPAWN_ID}'
           OR (spawn_id IS NULL AND agent_type = 'swe'
               AND (completed_at IS NULL
                    OR started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${SAFE_FIRST_TS}', '-2 seconds'))))
    ORDER BY (spawn_id IS NOT NULL) DESC, id DESC
    LIMIT 1);
INSERT INTO agent_runs (task_id, issue_id, agent_type, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, duration_ms, started_at, completed_at,
                        repo, spawn_id, session_id, usage_source, model, host, root_dir, exit_reason, effort)
SELECT ${SAFE_TASK_ID}, ${SAFE_ISSUE_ID}, 'swe', ${SAFE_TOKENS_IN}, ${SAFE_TOKENS_OUT}, ${SAFE_CACHE_READ_TOKENS},
       ${SAFE_CACHE_CREATION_TOKENS}, ${SAFE_TOOL_USES}, ${SAFE_DURATION_MS}, '${SAFE_FIRST_TS}', '${SAFE_NOW}',
       (SELECT repo FROM tasks WHERE id = ${SAFE_TASK_ID}), '${SAFE_SPAWN_ID}', ${SAFE_SESSION_SQL}, 'subagent_stop',
       ${SAFE_MODEL_SQL}, 'claude', '${SAFE_ROOT_DIR}', '${EXIT_REASON}', (SELECT effort FROM tasks WHERE id = ${SAFE_TASK_ID})
 WHERE (SELECT changes()) = 0;"; then
  jq -cn --arg ts "$ts" --argjson tid "$TASK_ID" \
    '{ts:$ts,kind:"agent-runs-write-failed",task_id:$tid}' \
    >> "$_LOG_FILE" 2>/dev/null || true
fi

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
