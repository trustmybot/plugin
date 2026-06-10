#!/usr/bin/env bash
# Stop hook — meters the bro main loop per session turn (#333).
#
# Fires on: Stop (main Claude session)
# Purpose: upsert an agent_runs row for agent='bro' with cumulative token
# usage from the session transcript. Each invocation re-reads the full
# transcript so totals are always up to date; idempotency comes from the
# open bro row (completed_at IS NULL) — we UPDATE, never INSERT.
#
# Failure modes are silent — this hook is analytics, never load-bearing.
# Bypass: TMB_DISABLE_BRO_TURN_USAGE_HOOK=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/normalize-role.sh
. "$SCRIPT_DIR/lib/normalize-role.sh"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_BRO_TURN_USAGE_HOOK:-0}" = "1" ]; then
  exit 0
fi

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0

# Find the open bro agent_run row for the current task.
RUN_ROW=$(sqlite3 -separator '|' "$DB_PATH" \
  "SELECT id, task_id FROM agent_runs WHERE agent_type = 'bro' AND completed_at IS NULL ORDER BY id DESC LIMIT 1;" 2>/dev/null)
[ -n "$RUN_ROW" ] || exit 0
RUN_ID="${RUN_ROW%%|*}"
TASK_ID="${RUN_ROW##*|}"
[ -n "$RUN_ID" ] || exit 0

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || true)
[ -n "$TRANSCRIPT_PATH" ] || exit 0
[ -f "$TRANSCRIPT_PATH" ] || exit 0

# Parse cumulative usage from the full transcript. Fields:
#   tokens_in|tokens_out|tool_uses|duration_ms|cache_read_tokens|cache_creation_tokens
# Use the same jq expression as swe-atomic-close.sh for consistency.
STATS=$(jq -rsc '
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
' "$TRANSCRIPT_PATH" 2>/dev/null) || true

[ -n "$STATS" ] || exit 0

TOKENS_IN=$(echo "$STATS" | cut -d'|' -f1)
TOKENS_OUT=$(echo "$STATS" | cut -d'|' -f2)
TOOL_USES=$(echo "$STATS" | cut -d'|' -f3)
DURATION_MS=$(echo "$STATS" | cut -d'|' -f4)
CACHE_READ_TOKENS=$(echo "$STATS" | cut -d'|' -f5)
CACHE_CREATION_TOKENS=$(echo "$STATS" | cut -d'|' -f6)

TOKENS_IN=$(printf '%d' "${TOKENS_IN}" 2>/dev/null || echo "0")
TOKENS_OUT=$(printf '%d' "${TOKENS_OUT}" 2>/dev/null || echo "0")
TOOL_USES=$(printf '%d' "${TOOL_USES}" 2>/dev/null || echo "0")
DURATION_MS=$(printf '%d' "${DURATION_MS}" 2>/dev/null || echo "0")
CACHE_READ_TOKENS=$(printf '%d' "${CACHE_READ_TOKENS}" 2>/dev/null || echo "0")
CACHE_CREATION_TOKENS=$(printf '%d' "${CACHE_CREATION_TOKENS}" 2>/dev/null || echo "0")
TOKENS_TOTAL=$((TOKENS_IN + TOKENS_OUT))

sqlite3 "$DB_PATH" \
  "UPDATE agent_runs
      SET tokens_in = ${TOKENS_IN},
          tokens_out = ${TOKENS_OUT},
          tokens_total = ${TOKENS_TOTAL},
          cache_read_tokens = ${CACHE_READ_TOKENS},
          cache_creation_tokens = ${CACHE_CREATION_TOKENS},
          tool_uses = ${TOOL_USES},
          duration_ms = ${DURATION_MS}
    WHERE id = ${RUN_ID}
      AND completed_at IS NULL;" 2>/dev/null || true

exit 0
