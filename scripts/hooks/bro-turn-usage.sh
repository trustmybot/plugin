#!/usr/bin/env bash
# Stop hook — meters the bro main loop by time window.
#
# Fires on: Stop (main Claude session)
# Purpose: each bro agent_runs row covers [started_at, completed_at) of one
# task. Its model is the dominant message.model inside that window (the model
# with the most tokens there). Its tokens are the sum of the session transcript's usage over the
# assistant messages inside that window (the newest started_at wins where
# windows overlap; the window start is widened by 2 s for clock skew). The sums
# are recomputed absolutely on every Stop, so the hook is idempotent and the
# final turn is captured even for a row bro_atomic_close closed mid-turn.
#
# Session claim: bro rows with no session_id that started after this session's
# first transcript message and are open (or closed within the last 24 h, e.g.
# opened and closed inside one turn) take this session's id; afterwards the hook
# only touches rows carrying its own session_id. Rows of this session closed
# within the last 24 h are recomputed too.
#
# One tmb_db_write transaction: claim + recompute. Analytics, never
# load-bearing: a failed write is reported on stderr and the hook exits 0.
# Bypass: TMB_DISABLE_BRO_TURN_USAGE_HOOK=1.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/query-task.sh
. "$SCRIPT_DIR/lib/query-task.sh"
# shellcheck source=lib/db-write.sh
. "$SCRIPT_DIR/lib/db-write.sh"

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
command -v sqlite3 >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_BRO_TURN_USAGE_HOOK:-0}" = "1" ]; then
  exit 0
fi

DB_PATH=$(tmb_db_path 2>/dev/null || true)
[ -n "$DB_PATH" ] || exit 0
[ -f "$DB_PATH" ] || exit 0

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || true)
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || true)
[ -n "$SESSION_ID" ] || exit 0
[ -n "$TRANSCRIPT_PATH" ] || exit 0
[ -f "$TRANSCRIPT_PATH" ] || exit 0

# One pass over the transcript. Line 1: the session's first timestamp. Line 2:
# one SQL VALUES row per main-loop assistant message (ts, in, out, cache_read,
# cache_creation, tool_uses, model). A model id keeps only [A-Za-z0-9._:@/[]-];
# CC's synthetic messages (<synthetic>) carry no model. CC writes one JSONL line per content block, each
# repeating the message's usage, so lines are grouped by message id (last
# usage wins, tool_use blocks are counted across the group). Timestamps are
# validated and normalized to the 24-char ms-ISO form; numbers are floored
# non-negative integers, anything else counts as 0.
PARSED=$(jq -rsc --arg q "'" '
  def iso:
    if type == "string" then
      (capture("^(?<s>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(\\.(?<f>[0-9]+))?Z$")
        // null)
      | if . == null then null else .s + "." + (((.f // "") + "000")[0:3]) + "Z" end
    else null end;
  def n: if type == "number" and . >= 0 then floor else 0 end;
  def model:
    if type == "string" and (startswith("<") | not) then gsub("[^A-Za-z0-9._:@/\\[\\]-]"; "")
    else "" end
    | if . == "" then "NULL" else $q + . + $q end;
  ([.[] | .timestamp | iso | select(. != null)] | min) as $first |
  [ to_entries[] | .key as $i | .value
    | select((.isSidechain // false) == false and .message.usage != null)
    | {id: (.message.id // .uuid // ("line-" + ($i | tostring))), ts: (.timestamp | iso), u: .message.usage,
       m: (.message.model | model),
       tu: ([.message.content // [] | arrays | .[] | select(.type == "tool_use")] | length)}
    | select(.ts != null)
  ]
  | group_by(.id)
  | map({ts: (map(.ts) | min), u: .[-1].u, m: .[-1].m, tu: (map(.tu) | add)})
  | sort_by(.ts)
  | map("(" + $q + .ts + $q + "," + ([.u.input_tokens, .u.output_tokens, .u.cache_read_input_tokens,
          .u.cache_creation_input_tokens, .tu] | map(n | tostring) | join(",")) + "," + .m + ")")
  | [($first // ""), join(",")]
  | .[]
' "$TRANSCRIPT_PATH" 2>/dev/null) || exit 0

FIRST_TS=$(printf '%s\n' "$PARSED" | sed -n 1p)
SAFE_MSG_VALUES=$(printf '%s\n' "$PARSED" | sed -n 2p)
case "$FIRST_TS" in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z) ;;
  *) exit 0 ;;
esac
[ -n "$SAFE_MSG_VALUES" ] || SAFE_MSG_VALUES="(NULL,0,0,0,0,0,NULL)"

SAFE_SESSION=$(tmb_sql_quote "$SESSION_ID")
SAFE_FIRST_TS=$(tmb_sql_quote "$FIRST_TS")
SAFE_NOW=$(tmb_sql_quote "$(tmb_now_iso)")

tmb_db_write "$DB_PATH" "
UPDATE agent_runs
   SET session_id = '${SAFE_SESSION}'
 WHERE agent_type = 'bro'
   AND session_id IS NULL
   AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${SAFE_FIRST_TS}', '-2 seconds')
   AND (completed_at IS NULL
        OR completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${SAFE_NOW}', '-24 hours'));

WITH msgs(ts, ti, tout, cr, cc, tu, model) AS (VALUES ${SAFE_MSG_VALUES}),
runs AS (
  SELECT id, started_at, completed_at,
         strftime('%Y-%m-%dT%H:%M:%fZ', started_at, '-2 seconds') AS window_start
    FROM agent_runs
   WHERE agent_type = 'bro' AND session_id = '${SAFE_SESSION}' AND started_at IS NOT NULL
),
owned AS (
  SELECT m.ti, m.tout, m.cr, m.cc, m.tu, m.model,
         (SELECT r.id FROM runs r
           WHERE r.window_start <= m.ts AND (r.completed_at IS NULL OR m.ts < r.completed_at)
           ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS run_id
    FROM msgs m
   WHERE m.ts IS NOT NULL
),
sums AS (
  SELECT run_id, SUM(ti) AS ti, SUM(tout) AS tout, SUM(cr) AS cr, SUM(cc) AS cc, SUM(tu) AS tu
    FROM owned WHERE run_id IS NOT NULL GROUP BY run_id
),
models AS (
  SELECT run_id, model, SUM(ti + tout + cr + cc) AS tok
    FROM owned WHERE run_id IS NOT NULL AND model IS NOT NULL GROUP BY run_id, model
)
UPDATE agent_runs
   SET tokens_in             = COALESCE((SELECT ti FROM sums WHERE sums.run_id = agent_runs.id), 0),
       tokens_out            = COALESCE((SELECT tout FROM sums WHERE sums.run_id = agent_runs.id), 0),
       cache_read_tokens     = COALESCE((SELECT cr FROM sums WHERE sums.run_id = agent_runs.id), 0),
       cache_creation_tokens = COALESCE((SELECT cc FROM sums WHERE sums.run_id = agent_runs.id), 0),
       tool_uses             = COALESCE((SELECT tu FROM sums WHERE sums.run_id = agent_runs.id), 0),
       duration_ms           = MAX(0, CAST(ROUND((julianday(COALESCE(completed_at, '${SAFE_NOW}')) - julianday(started_at)) * 86400000) AS INTEGER)),
       usage_source          = 'transcript',
       model                 = COALESCE((SELECT model FROM models WHERE models.run_id = agent_runs.id
                                          ORDER BY tok DESC, model LIMIT 1), model),
       host                  = COALESCE(host, 'claude')
 WHERE agent_type = 'bro'
   AND session_id = '${SAFE_SESSION}'
   AND started_at IS NOT NULL
   AND (completed_at IS NULL
        OR completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${SAFE_NOW}', '-24 hours'));
" || exit 0

exit 0
