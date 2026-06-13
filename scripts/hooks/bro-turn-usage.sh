#!/usr/bin/env bash
# Stop hook — meters the bro main loop per session turn (#333).
#
# Fires on: Stop (main Claude session)
# Purpose: attribute per-task token deltas to each open bro agent_run row.
# Each row carries a write-once usage_baseline_json checkpoint; delta =
# max(0, cumulative_now − baseline). Idempotent: baseline is set once
# (WHERE usage_baseline_json IS NULL guard).
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

# Find the active row: newest open bro agent_run.
RUN_ROW=$(sqlite3 -separator '|' "$DB_PATH" \
  "SELECT id, usage_baseline_json FROM agent_runs WHERE agent_type='bro' AND completed_at IS NULL ORDER BY id DESC LIMIT 1;" 2>/dev/null)
[ -n "$RUN_ROW" ] || exit 0
RUN_ID="${RUN_ROW%%|*}"
[ -n "$RUN_ID" ] || exit 0

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || true)
[ -n "$TRANSCRIPT_PATH" ] || exit 0
[ -f "$TRANSCRIPT_PATH" ] || exit 0

# Parse cumulative usage from the full transcript. Fields:
#   tokens_in|tokens_out|tool_uses|duration_ms|cache_read_tokens|cache_creation_tokens
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

CUM_TI=$(echo "$STATS" | cut -d'|' -f1)
CUM_TO=$(echo "$STATS" | cut -d'|' -f2)
CUM_TU=$(echo "$STATS" | cut -d'|' -f3)
CUM_DM=$(echo "$STATS" | cut -d'|' -f4)
CUM_CR=$(echo "$STATS" | cut -d'|' -f5)
CUM_CC=$(echo "$STATS" | cut -d'|' -f6)

case "${CUM_TI}" in (''|*[!0-9]*) CUM_TI=0 ;; esac
case "${CUM_TO}" in (''|*[!0-9]*) CUM_TO=0 ;; esac
case "${CUM_TU}" in (''|*[!0-9]*) CUM_TU=0 ;; esac
case "${CUM_DM}" in (''|*[!0-9]*) CUM_DM=0 ;; esac
case "${CUM_CR}" in (''|*[!0-9]*) CUM_CR=0 ;; esac
case "${CUM_CC}" in (''|*[!0-9]*) CUM_CC=0 ;; esac

# If the active row has no baseline yet, compute the per-field high-water mark
# over all prior bro rows and set it (write-once via IS NULL guard).
BASELINE_ROW=$(sqlite3 -separator '|' "$DB_PATH" "
  SELECT
    COALESCE(MAX(COALESCE(json_extract(usage_baseline_json,'$.ti'),0) + tokens_in), 0),
    COALESCE(MAX(COALESCE(json_extract(usage_baseline_json,'$.to'),0) + tokens_out), 0),
    COALESCE(MAX(COALESCE(json_extract(usage_baseline_json,'$.cr'),0) + cache_read_tokens), 0),
    COALESCE(MAX(COALESCE(json_extract(usage_baseline_json,'$.cc'),0) + cache_creation_tokens), 0),
    COALESCE(MAX(COALESCE(json_extract(usage_baseline_json,'$.tu'),0) + tool_uses), 0),
    COALESCE(MAX(COALESCE(json_extract(usage_baseline_json,'$.dm'),0) + duration_ms), 0)
  FROM agent_runs WHERE agent_type='bro' AND id < ${RUN_ID};
" 2>/dev/null) || true

BL_TI=$(echo "$BASELINE_ROW" | cut -d'|' -f1)
BL_TO=$(echo "$BASELINE_ROW" | cut -d'|' -f2)
BL_CR=$(echo "$BASELINE_ROW" | cut -d'|' -f3)
BL_CC=$(echo "$BASELINE_ROW" | cut -d'|' -f4)
BL_TU=$(echo "$BASELINE_ROW" | cut -d'|' -f5)
BL_DM=$(echo "$BASELINE_ROW" | cut -d'|' -f6)

case "${BL_TI}" in (''|*[!0-9]*) BL_TI=0 ;; esac
case "${BL_TO}" in (''|*[!0-9]*) BL_TO=0 ;; esac
case "${BL_CR}" in (''|*[!0-9]*) BL_CR=0 ;; esac
case "${BL_CC}" in (''|*[!0-9]*) BL_CC=0 ;; esac
case "${BL_TU}" in (''|*[!0-9]*) BL_TU=0 ;; esac
case "${BL_DM}" in (''|*[!0-9]*) BL_DM=0 ;; esac

BASELINE_JSON="{\"ti\":${BL_TI},\"to\":${BL_TO},\"cr\":${BL_CR},\"cc\":${BL_CC},\"tu\":${BL_TU},\"dm\":${BL_DM}}"

# Write-once: only set baseline if the active row's usage_baseline_json IS NULL.
sqlite3 "$DB_PATH" \
  "UPDATE agent_runs SET usage_baseline_json='${BASELINE_JSON}' WHERE id=${RUN_ID} AND usage_baseline_json IS NULL;" 2>/dev/null || true

# Re-read the baseline (now guaranteed non-NULL) to compute deltas.
STORED_BL=$(sqlite3 "$DB_PATH" \
  "SELECT usage_baseline_json FROM agent_runs WHERE id=${RUN_ID};" 2>/dev/null) || true
[ -n "$STORED_BL" ] || STORED_BL="$BASELINE_JSON"

# Extract baseline fields from stored JSON.
SBL_TI=$(echo "$STORED_BL" | jq -r '.ti // 0' 2>/dev/null || echo 0)
SBL_TO=$(echo "$STORED_BL" | jq -r '.to // 0' 2>/dev/null || echo 0)
SBL_CR=$(echo "$STORED_BL" | jq -r '.cr // 0' 2>/dev/null || echo 0)
SBL_CC=$(echo "$STORED_BL" | jq -r '.cc // 0' 2>/dev/null || echo 0)
SBL_TU=$(echo "$STORED_BL" | jq -r '.tu // 0' 2>/dev/null || echo 0)
SBL_DM=$(echo "$STORED_BL" | jq -r '.dm // 0' 2>/dev/null || echo 0)

case "${SBL_TI}" in (''|*[!0-9]*) SBL_TI=0 ;; esac
case "${SBL_TO}" in (''|*[!0-9]*) SBL_TO=0 ;; esac
case "${SBL_CR}" in (''|*[!0-9]*) SBL_CR=0 ;; esac
case "${SBL_CC}" in (''|*[!0-9]*) SBL_CC=0 ;; esac
case "${SBL_TU}" in (''|*[!0-9]*) SBL_TU=0 ;; esac
case "${SBL_DM}" in (''|*[!0-9]*) SBL_DM=0 ;; esac

# Compute per-field delta = max(0, cumulative_now - baseline).
DTI=$(( CUM_TI > SBL_TI ? CUM_TI - SBL_TI : 0 ))
DTO=$(( CUM_TO > SBL_TO ? CUM_TO - SBL_TO : 0 ))
DCR=$(( CUM_CR > SBL_CR ? CUM_CR - SBL_CR : 0 ))
DCC=$(( CUM_CC > SBL_CC ? CUM_CC - SBL_CC : 0 ))
DTU=$(( CUM_TU > SBL_TU ? CUM_TU - SBL_TU : 0 ))
DDM=$(( CUM_DM > SBL_DM ? CUM_DM - SBL_DM : 0 ))
DTOTAL=$(( DTI + DTO ))

sqlite3 "$DB_PATH" \
  "UPDATE agent_runs
      SET tokens_in = ${DTI},
          tokens_out = ${DTO},
          tokens_total = ${DTOTAL},
          cache_read_tokens = ${DCR},
          cache_creation_tokens = ${DCC},
          tool_uses = ${DTU},
          duration_ms = ${DDM}
    WHERE id = ${RUN_ID}
      AND completed_at IS NULL;" 2>/dev/null || true

exit 0
