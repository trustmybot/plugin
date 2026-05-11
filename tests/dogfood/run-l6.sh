#!/usr/bin/env bash
# L6 — multi-turn integration runner. Drives multi-turn scenarios that span
# multiple flows / continuous bro sessions. See tests/EVALUATION.md.
#
# Usage:
#   bash tests/dogfood/run-l6.sh                  # all scenarios
#   bash tests/dogfood/run-l6.sh <name-substring> # one scenario
#
# Requirements:
#   - CLAUDE_CODE_OAUTH_TOKEN env var
#   - claude in PATH
#   - sqlite3, jq, git

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
FILTER="${1:-}"
export PLUGIN_ROOT

. "$HERE/lib/l6-helpers.sh"

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n"
  printf "   For local runs: export CLAUDE_CODE_OAUTH_TOKEN=...\n"
  exit 1
fi

for cmd in claude sqlite3 jq git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "❌ %s not found in PATH.\n" "$cmd"
    exit 1
  fi
done

# Pre-flight substrate health (mirrors L5).
. "$HERE/lib/smoke-helpers.sh"
l5_pre_flight_or_abort "$PLUGIN_ROOT"

printf "=== claude --version ===\n"
claude --version 2>&1 | sed 's/^/  /' || echo "  ✗ claude --version failed"
printf "\n"

PASS=0
FAIL=0
FAILED_SCENARIOS=()

SCENARIOS_ROOT="$HERE/l5-rows"
[ -d "$SCENARIOS_ROOT" ] || {
  printf "❌ no scenarios at %s\n" "$SCENARIOS_ROOT"
  exit 1
}

for scenario_dir in "$SCENARIOS_ROOT"/*/; do
  [ -d "$scenario_dir" ] || continue
  scenario_name=$(basename "$scenario_dir")

  # Skip the misc/ bucket — those aren't journey rows. Run them explicitly via
  # the filter if needed (e.g. `bash run-l6.sh legacy-onboard-then-task`).
  if [ "$scenario_name" = "misc" ]; then
    continue
  fi

  if [ -n "$FILTER" ] && [[ "$scenario_name" != *"$FILTER"* ]]; then
    continue
  fi

  printf "\n=== L6 scenario: %s ===\n" "$scenario_name"

  RUN_ID="${RUN_ID:-$(date +%s)-$$}-${scenario_name}"
  SCENARIO_NAME="$scenario_name"
  export RUN_ID SCENARIO_NAME

  fixture=$(cat "$scenario_dir/fixture.txt" 2>/dev/null | tr -d '\n' || echo "empty")

  PROJECT=$(l6_setup_scratch_project)
  trap 'l6_cleanup_project "$PROJECT"' EXIT

  l6_seed_db "$PROJECT" "$fixture" || {
    printf "  ✗ scenario %s: fixture seed failed\n" "$scenario_name"
    FAIL=$((FAIL + 1))
    FAILED_SCENARIOS+=("$scenario_name")
    continue
  }

  # Optional per-scenario setup hook (mirrors L5's run.sh setup section).
  if [ -f "$scenario_dir/setup.sh" ]; then
    bash "$scenario_dir/setup.sh" "$PROJECT" "$scenario_dir" || {
      printf "  ✗ scenario %s: setup.sh failed\n" "$scenario_name"
      FAIL=$((FAIL + 1))
      FAILED_SCENARIOS+=("$scenario_name")
      continue
    }
  fi

  l6_run_session "$PROJECT" "$scenario_dir"

  if l6_score_session "$PROJECT" "$scenario_name" "$scenario_dir" "$RUN_ID"; then
    printf "  ✓ %s passed\n" "$scenario_name"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s failed\n" "$scenario_name"
    FAIL=$((FAIL + 1))
    FAILED_SCENARIOS+=("$scenario_name")
  fi

  trap - EXIT
  l6_cleanup_project "$PROJECT"
done

printf "\n========================================\n"
printf "L6 dogfood: %d passed, %d failed\n" "$PASS" "$FAIL"
[ "$FAIL" = "0" ] && exit 0

printf "Failed scenarios: %s\n" "${FAILED_SCENARIOS[*]}"
exit 1
