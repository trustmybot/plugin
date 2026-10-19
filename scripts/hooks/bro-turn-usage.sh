#!/usr/bin/env bash
# Stop hook — meters the bro main loop per Claude Code session.
#
# Fires on: Stop (main Claude session)
# Purpose: bro lives per session, not per task, so each session owns exactly
# one bro agent_runs row: agent_type 'bro', task_id and issue_id NULL,
# session_id the payload's session. The row holds the sums of the session
# transcript's main-loop assistant usage; started_at / completed_at are the
# first / last main-loop message, model the one with the most tokens, root_dir
# the project holding the trajectory DB (NULL when the DB sits elsewhere).
# Every Stop rewrites the row with absolute sums and inserts it when absent, so
# the hook is idempotent. A session with no real model (only <synthetic>
# messages) or no output tokens writes no row; a row an earlier Stop wrote
# stays as it is.
# Per-task cost is the task's swe + pr-reviewer runs; no turn is split across
# tasks.
#
# One tmb_db_write transaction. Analytics, never load-bearing: a failed write
# is reported on stderr and the hook exits 0.
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

# One pass over the transcript, main loop only (isSidechain false). Prints one
# tab-separated line: first ts, last ts, in, out, cache_read, cache_creation,
# tool_uses, model — nothing when the main loop has no real model or no output
# tokens. CC writes one JSONL line per content block, each repeating the
# message's usage, so lines are grouped by message id (last usage wins,
# tool_use blocks are counted across the group). Timestamps are validated and normalized to the 24-char
# ms-ISO form; numbers are floored non-negative integers, anything else counts
# as 0. A model id keeps only [A-Za-z0-9._:@/[]-] and is emitted as a quoted
# SQL literal; CC's synthetic messages (<synthetic>) carry no model, and the
# model with the most tokens wins (ties by name).
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
    else "" end;
  [.[] | objects | select((.isSidechain // false) == false and .message != null)] as $main |
  [$main[] | .timestamp | iso | select(. != null)] as $stamps |
  [ $main | to_entries[] | .key as $i | .value
    | select(.message.usage != null)
    | {id: (.message.id // .uuid // ("line-" + ($i | tostring))), ts: (.timestamp | iso), u: .message.usage,
       m: (.message.model | model),
       tu: ([.message.content // [] | arrays | .[] | select(.type == "tool_use")] | length)}
    | select(.ts != null)
  ]
  | group_by(.id)
  | map({u: .[-1].u, m: .[-1].m, tu: (map(.tu) | add)}
        | {ti: (.u.input_tokens | n), to: (.u.output_tokens | n), cr: (.u.cache_read_input_tokens | n),
           cc: (.u.cache_creation_input_tokens | n), tu, m})
  | ([.[] | select(.m != "") | {m, tok: (.ti + .to + .cr + .cc)}]
     | group_by(.m) | map({m: .[0].m, tok: (map(.tok) | add)})
     | sort_by([-.tok, .m]) | .[0].m // null) as $model
  | select($model != null and (map(.to) | add) > 0)
  | [($stamps | min), ($stamps | max),
     (map(.ti) | add), (map(.to) | add), (map(.cr) | add), (map(.cc) | add), (map(.tu) | add)
       | tostring]
    + [$q + $model + $q]
  | join("\t")
' "$TRANSCRIPT_PATH" 2>/dev/null) || exit 0
[ -n "$PARSED" ] || exit 0

IFS=$'\t' read -r FIRST_TS LAST_TS T_IN T_OUT T_CR T_CC T_TU SAFE_MODEL <<<"$PARSED"
for stamp in "$FIRST_TS" "$LAST_TS"; do
  case "$stamp" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z) ;;
    *) exit 0 ;;
  esac
done
for num in "$T_IN" "$T_OUT" "$T_CR" "$T_CC" "$T_TU"; do
  case "$num" in
    '' | *[!0-9]*) exit 0 ;;
  esac
done

ROOT_SQL="NULL"
PROJECT_ROOT=$(dirname "$(dirname "$(dirname "$DB_PATH")")")
if [ "$(tmb_db_location "$PROJECT_ROOT")" = "$DB_PATH" ]; then
  ROOT_SQL="'$(tmb_sql_quote "$PROJECT_ROOT")'"
fi

SAFE_SESSION=$(tmb_sql_quote "$SESSION_ID")
SESSION_ROW="agent_type = 'bro' AND task_id IS NULL AND session_id = '${SAFE_SESSION}'"
DURATION_SQL="MAX(0, CAST(ROUND((julianday('${LAST_TS}') - julianday('${FIRST_TS}')) * 86400000) AS INTEGER))"

tmb_db_write "$DB_PATH" "
UPDATE agent_runs
   SET tokens_in             = ${T_IN},
       tokens_out            = ${T_OUT},
       cache_read_tokens     = ${T_CR},
       cache_creation_tokens = ${T_CC},
       tool_uses             = ${T_TU},
       started_at            = '${FIRST_TS}',
       completed_at          = '${LAST_TS}',
       duration_ms           = ${DURATION_SQL},
       usage_source          = 'transcript',
       model                 = ${SAFE_MODEL},
       host                  = 'claude',
       root_dir              = COALESCE(${ROOT_SQL}, root_dir),
       exit_reason           = 'completed'
 WHERE ${SESSION_ROW};

INSERT INTO agent_runs (agent_type, task_id, issue_id, session_id, tokens_in, tokens_out, cache_read_tokens,
                        cache_creation_tokens, tool_uses, started_at, completed_at, duration_ms,
                        usage_source, model, host, root_dir, exit_reason)
SELECT 'bro', NULL, NULL, '${SAFE_SESSION}', ${T_IN}, ${T_OUT}, ${T_CR}, ${T_CC}, ${T_TU},
       '${FIRST_TS}', '${LAST_TS}', ${DURATION_SQL}, 'transcript', ${SAFE_MODEL}, 'claude', ${ROOT_SQL}, 'completed'
 WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE ${SESSION_ROW});
" || exit 0

exit 0
