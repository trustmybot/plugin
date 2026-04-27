#!/usr/bin/env bash
# A/B prompt-eval report (#131). Reads eval_results for a scenario, groups
# by arm + scorer, computes per-arm pass-rate + chi-squared p-value.
#
# Usage:
#   bash tests/dogfood/scripts/ab-report.sh <scenario-name>
#   bash tests/dogfood/scripts/ab-report.sh <scenario-name> --db /path/to/trajectory.db
#
# Reads from any reachable trajectory.db (project-local or test-temp). The
# A/B scenarios run in scratch dirs that are deleted after — to retain results
# for reporting, set L5_KEEP_ARTIFACTS=1 when invoking run-ab.sh, then point
# this script at one of the surviving trajectory.dbs (or a merged copy).

set -uo pipefail

SCENARIO="${1:-}"
DB_PATH=""
shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    *) printf "Unknown arg: %s\n" "$1"; exit 1 ;;
  esac
done

if [ -z "$SCENARIO" ]; then
  printf "Usage: bash %s <scenario-name> [--db <path>]\n" "$0"
  exit 1
fi

if [ -z "$DB_PATH" ]; then
  # Default: look in $PWD/.claude/tmb/trajectory.db
  DB_PATH="$PWD/.claude/tmb/trajectory.db"
fi

if [ ! -f "$DB_PATH" ]; then
  printf "❌ DB not found: %s\n" "$DB_PATH"
  printf "   Hint: A/B scratch dirs are deleted unless L5_KEEP_ARTIFACTS=1.\n"
  exit 1
fi

printf "=== A/B report: %s ===\n" "$SCENARIO"
printf "  DB: %s\n\n" "$DB_PATH"

# Per-arm × per-scorer pass-rates
sqlite3 -separator '|' "$DB_PATH" \
  "SELECT arm, scorer_name, SUM(pass) AS passed, COUNT(*) AS total
   FROM eval_results
   WHERE scenario = '$SCENARIO'
   GROUP BY arm, scorer_name
   ORDER BY scorer_name, arm" 2>/dev/null \
  | awk -F'|' 'BEGIN { printf "%-20s %-30s %10s %10s %12s\n", "arm", "scorer", "passed", "total", "pass-rate" }
               { rate = ($4 > 0) ? ($3 / $4) * 100 : 0
                 printf "%-20s %-30s %10s %10s %11.1f%%\n", $1, $2, $3, $4, rate }'

printf "\n=== Chi-squared per scorer (2x2 contingency, df=1) ===\n"
printf "  Critical χ² for p < 0.05 = 3.841\n"
printf "  Critical χ² for p < 0.01 = 6.635\n\n"

# For each scorer, compute χ² across the first two arms (most common A/B case).
# For >2 arms, report pairwise A vs others.
SCORERS=$(sqlite3 "$DB_PATH" "SELECT DISTINCT scorer_name FROM eval_results WHERE scenario = '$SCENARIO'" 2>/dev/null)
ARMS=$(sqlite3 "$DB_PATH" "SELECT DISTINCT arm FROM eval_results WHERE scenario = '$SCENARIO' ORDER BY arm" 2>/dev/null)

# Compute χ² for each scorer between arms[0] and arms[1] (extend later for >2 arms)
ARM_A=$(echo "$ARMS" | sed -n '1p')
ARM_B=$(echo "$ARMS" | sed -n '2p')

if [ -z "$ARM_A" ] || [ -z "$ARM_B" ]; then
  printf "  (need ≥2 arms with data to compute χ²)\n"
  exit 0
fi

while IFS= read -r scorer; do
  [ -z "$scorer" ] && continue
  PASS_A=$(sqlite3 "$DB_PATH" "SELECT COALESCE(SUM(pass), 0) FROM eval_results WHERE scenario='$SCENARIO' AND scorer_name='$scorer' AND arm='$ARM_A'")
  TOTAL_A=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM eval_results WHERE scenario='$SCENARIO' AND scorer_name='$scorer' AND arm='$ARM_A'")
  PASS_B=$(sqlite3 "$DB_PATH" "SELECT COALESCE(SUM(pass), 0) FROM eval_results WHERE scenario='$SCENARIO' AND scorer_name='$scorer' AND arm='$ARM_B'")
  TOTAL_B=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM eval_results WHERE scenario='$SCENARIO' AND scorer_name='$scorer' AND arm='$ARM_B'")

  FAIL_A=$((TOTAL_A - PASS_A))
  FAIL_B=$((TOTAL_B - PASS_B))

  CHISQ=$(awk -v a="$PASS_A" -v b="$FAIL_A" -v c="$PASS_B" -v d="$FAIL_B" '
    BEGIN {
      n = a + b + c + d
      if (n == 0) { print "n/a"; exit }
      ea = (a + b) * (a + c) / n
      eb_v = (a + b) * (b + d) / n
      ec = (c + d) * (a + c) / n
      ed = (c + d) * (b + d) / n
      x = 0
      if (ea > 0) x += (a - ea)^2 / ea
      if (eb_v > 0) x += (b - eb_v)^2 / eb_v
      if (ec > 0) x += (c - ec)^2 / ec
      if (ed > 0) x += (d - ed)^2 / ed
      printf "%.3f", x
    }')

  SIG="ns"
  if [ "$CHISQ" != "n/a" ]; then
    awk_check=$(awk -v x="$CHISQ" 'BEGIN { if (x >= 6.635) print "p<0.01"; else if (x >= 3.841) print "p<0.05"; else print "ns" }')
    SIG="$awk_check"
  fi

  printf "  %-30s %s vs %s: χ²=%s [%s]\n" "$scorer" "$ARM_A" "$ARM_B" "$CHISQ" "$SIG"
done <<< "$SCORERS"
