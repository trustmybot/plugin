#!/usr/bin/env bash
# Stop hook — meters the bro main loop by time window.
#
# Fires on: Stop (main Claude session)
# Purpose: each bro agent_runs row covers [started_at, completed_at) of one
# task. Its model is the dominant message.model inside that window (the model
# with the most tokens there). Its tokens are the sum of the session transcript's usage over the
# assistant messages inside that window (the window start is widened by 2 s for
# clock skew). The sums are recomputed absolutely on every Stop, so the hook is
# idempotent and the final turn is captured even for a row bro_atomic_close
# closed mid-turn.
#
# Overlapping windows (e.g. task_create_batch opens N rows at one instant): a
# message goes to the row whose task is running at the message's timestamp
# (its status is running and was set at or before it, or a swe row of the task
# is open then); else to the row whose task was most recently briefed at or
# before it (its swe_brief_fetched audit row); else to the newest started_at.
#
# Session: the server stamps session_id when bro passes it to task_provision /
# task_create_batch / task_retry. Legacy claim, only for rows opened without
# it: bro rows with no session_id that started after this session's first
# transcript message and are open (or closed within the last 24 h, e.g. opened
# and closed inside one turn) take this session's id, and one
# agent_runs_claimed audit row ({run_ids, session_id}) records the claim. The
# hook only meters rows carrying its own session_id; rows of this session
# closed within the last 24 h are recomputed too.
#
# One tmb_db_write transaction: claim + audit + recompute. Analytics, never
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

CLAIMABLE="agent_type = 'bro'
   AND session_id IS NULL
   AND started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${SAFE_FIRST_TS}', '-2 seconds')
   AND (completed_at IS NULL
        OR completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', '${SAFE_NOW}', '-24 hours'))"

tmb_db_write "$DB_PATH" "
INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, repo, created_at)
SELECT c.issue_id, NULL, 'hook:bro-turn-usage', 'agent_runs_claimed',
       'Stop hook claimed ' || c.n || ' bro agent_runs row(s) opened without session_id',
       json_object('run_ids', json(c.run_ids), 'session_id', '${SAFE_SESSION}'),
       (SELECT repo FROM issues WHERE id = c.issue_id), '${SAFE_NOW}'
  FROM (SELECT COUNT(*) AS n, json_group_array(id) AS run_ids,
               CASE WHEN COUNT(DISTINCT issue_id) = 1 AND COUNT(issue_id) = COUNT(*)
                    THEN MIN(issue_id) ELSE -1 END AS issue_id
          FROM (SELECT id, issue_id FROM agent_runs WHERE ${CLAIMABLE} ORDER BY id)) AS c
 WHERE c.n > 0;

UPDATE agent_runs
   SET session_id = '${SAFE_SESSION}'
 WHERE ${CLAIMABLE};

WITH msgs(ts, ti, tout, cr, cc, tu, model) AS (VALUES ${SAFE_MSG_VALUES}),
keyed AS (
  SELECT ROW_NUMBER() OVER () AS k, ts, ti, tout, cr, cc, tu, model FROM msgs WHERE ts IS NOT NULL
),
runs AS (
  SELECT r.id, r.task_id, r.started_at, r.completed_at,
         strftime('%Y-%m-%dT%H:%M:%fZ', r.started_at, '-2 seconds') AS window_start,
         CASE WHEN t.status = 'running' THEN t.updated_at END AS running_since
    FROM agent_runs r LEFT JOIN tasks t ON t.id = r.task_id
   WHERE r.agent_type = 'bro' AND r.session_id = '${SAFE_SESSION}' AND r.started_at IS NOT NULL
),
swe_runs AS (
  SELECT task_id, started_at, completed_at FROM agent_runs
   WHERE agent_type = 'swe' AND started_at IS NOT NULL
     AND task_id IN (SELECT task_id FROM runs)
),
briefs AS (
  SELECT CAST(json_extract(content_json, '\$.task_id') AS INTEGER) AS task_id, created_at
    FROM audit
   WHERE event_type = 'swe_brief_fetched'
     AND CAST(json_extract(content_json, '\$.task_id') AS INTEGER) IN (SELECT task_id FROM runs)
),
candidates AS (
  SELECT m.k, r.id AS run_id, r.started_at,
         CASE WHEN r.running_since <= m.ts
                OR EXISTS (SELECT 1 FROM swe_runs s
                            WHERE s.task_id = r.task_id AND s.started_at <= m.ts
                              AND (s.completed_at IS NULL OR m.ts < s.completed_at))
              THEN 1 ELSE 0 END AS active,
         COALESCE((SELECT MAX(b.created_at) FROM briefs b
                    WHERE b.task_id = r.task_id AND b.created_at <= m.ts), '') AS briefed_at
    FROM keyed m
    JOIN runs r ON r.window_start <= m.ts AND (r.completed_at IS NULL OR m.ts < r.completed_at)
),
picked AS (
  SELECT k, run_id FROM (
    SELECT k, run_id,
           ROW_NUMBER() OVER (PARTITION BY k
                              ORDER BY active DESC, briefed_at DESC, started_at DESC, run_id DESC) AS rn
      FROM candidates)
   WHERE rn = 1
),
owned AS (
  SELECT m.ti, m.tout, m.cr, m.cc, m.tu, m.model, p.run_id
    FROM keyed m JOIN picked p ON p.k = m.k
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
