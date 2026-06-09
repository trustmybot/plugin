#!/usr/bin/env bash
# Token-saving axis: how many tokens did the agent consume end-to-end?
#
# Two sources, used as a cross-check:
# 1. Transcript stream-json — `type=result` events carry `total_tokens` per
#    turn. Sum these across the whole transcript. Works for both arms.
# 2. agent_runs.tokens_total — bro + SWE rows on arm A. Arm B has no DB.
#
# When both numbers exist they should roughly agree (arm A only). Discrepancy
# > 20% surfaces in the warnings field. Stream-json is the load-bearing
# source; agent_runs is the analytics overlay.
#
# Usage:
#   bash token-saving.sh <transcript_path> [db_path]
#
# Writes JSON to stdout: { axis, total_tokens, transcript_tokens, agent_runs_tokens, warnings }

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/l7/lib/bench-helpers.sh
. "$HERE/../lib/bench-helpers.sh"

TRANSCRIPT="${1:?transcript_path required}"
DB="${2:-}"

TRANSCRIPT_TOKENS=$(bench_tokens_from_transcript "$TRANSCRIPT")
COST_USD=$(bench_cost_from_transcript "$TRANSCRIPT")
AGENT_RUNS_TOKENS=0
if [ -n "$DB" ] && [ -f "$DB" ]; then
  AGENT_RUNS_TOKENS=$(bench_tokens_from_agent_runs "$DB")
fi

# Prefer transcript total (always present, includes both arms). Warn if
# agent_runs disagrees significantly when present.
TOTAL="$TRANSCRIPT_TOKENS"
WARNINGS="[]"
if [ -n "$DB" ] && [ -f "$DB" ] && [ "$AGENT_RUNS_TOKENS" -gt 0 ]; then
  # 20% discrepancy threshold
  DELTA=$((TRANSCRIPT_TOKENS - AGENT_RUNS_TOKENS))
  if [ "$DELTA" -lt 0 ]; then DELTA=$((-DELTA)); fi
  THRESHOLD=$((TRANSCRIPT_TOKENS / 5))
  if [ "$DELTA" -gt "$THRESHOLD" ] && [ "$THRESHOLD" -gt 0 ]; then
    WARNINGS=$(jq -nc --arg t "$TRANSCRIPT_TOKENS" --arg a "$AGENT_RUNS_TOKENS" \
      '["transcript=" + $t + " disagrees with agent_runs=" + $a + " by >20%"]')
  fi
fi

jq -nc --argjson total "$TOTAL" --argjson tt "$TRANSCRIPT_TOKENS" \
       --argjson ar "$AGENT_RUNS_TOKENS" --argjson cost "$COST_USD" \
       --argjson warn "$WARNINGS" \
  '{axis: "token_saving", total_tokens: $total, cost_usd: $cost, transcript_tokens: $tt, agent_runs_tokens: $ar, warnings: $warn}'
