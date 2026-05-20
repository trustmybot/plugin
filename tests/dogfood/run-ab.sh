#!/usr/bin/env bash
# A/B prompt-eval runner (#131). Takes a scenario directory, runs each arm
# N times against the same flow, writes per-arm results to eval_results.
#
# Usage:
#   bash tests/dogfood/run-ab.sh <scenario-name>           # default N=5 pairs
#   N=10 bash tests/dogfood/run-ab.sh <scenario-name>      # custom N
#
# Scenario dir layout (under tests/dogfood/ab-scenarios/<name>/):
#   scenario.json          — { "flow": "<flow-name>", "prompt": "<prompt>", "arms": ["A", "B", ...] }
#   arms/<arm>/            — overrides layered on top of $PLUGIN_ROOT for this arm
#                            (mirrors plugin tree layout — e.g. arms/A/CLAUDE.md
#                             overrides the plugin's CLAUDE.md when arm A runs)
#
# Reuses the scorer config (outcome.sql + tools-required.json + tools-forbidden.json
# + cost-budget.json) from tests/dogfood/rows/<flow>/.
#
# Token-heavy: each arm-pair = 2 full claude -p invocations. Default N=5 → 10
# claude calls per scenario. Treat as opt-in (similar to Release canary scope);
# never CI-required.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
export PLUGIN_ROOT
export TMB_EVAL_MODE=1

SCENARIO_NAME="${1:-}"
N="${N:-5}"

if [ -z "$SCENARIO_NAME" ]; then
  printf "Usage: bash %s <scenario-name> [N=pairs-per-arm, default 5]\n" "$0"
  printf "\nAvailable scenarios:\n"
  for d in "$HERE/ab-scenarios"/*/; do
    [ -d "$d" ] && printf "  %s\n" "$(basename "$d")"
  done
  exit 1
fi

SCENARIO_DIR="$HERE/ab-scenarios/$SCENARIO_NAME"
if [ ! -d "$SCENARIO_DIR" ]; then
  printf "❌ Scenario not found: %s\n" "$SCENARIO_DIR"
  exit 1
fi

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "❌ CLAUDE_CODE_OAUTH_TOKEN not set — A/B runs need real claude calls.\n"
  exit 1
fi

for cmd in claude sqlite3 jq rsync; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "❌ %s not found in PATH.\n" "$cmd"
    exit 1
  fi
done

. "$HERE/lib/flow-helpers.sh"
. "$HERE/lib/smoke-helpers.sh"
. "$HERE/lib/ab-helpers.sh"
. "$HERE/lib/sandbox.sh"

# Parse scenario.json
FLOW=$(jq -r '.flow' "$SCENARIO_DIR/scenario.json")
PROMPT=$(jq -r '.prompt' "$SCENARIO_DIR/scenario.json")
ARMS=$(jq -r '.arms[]' "$SCENARIO_DIR/scenario.json")
SCORER_DIR="$HERE/rows/$FLOW"

if [ ! -d "$SCORER_DIR" ]; then
  printf "❌ Row scorer dir not found: %s\n" "$SCORER_DIR"
  exit 1
fi

printf "\n=== A/B scenario: %s ===\n" "$SCENARIO_NAME"
printf "  Flow:   %s\n" "$FLOW"
printf "  Prompt: %s\n" "$PROMPT"
printf "  Arms:   %s\n" "$(echo "$ARMS" | tr '\n' ' ')"
printf "  N (pairs per arm): %s\n\n" "$N"

# Pre-flight: substrate health on the SOURCE plugin first (catches L0–L4
# class issues before we even build per-arm copies), then MCP smoke on
# each arm's plugin tree (catches arm-specific overlay breakage).
l5_pre_flight_or_abort "$PLUGIN_ROOT"

printf "=== Per-arm MCP smoke (post-rsync overlay) ===\n"
SMOKE_FAIL=0
for arm in $ARMS; do
  printf "  arm=%s: " "$arm"
  SMOKE_PLUGIN=$(l5_make_arm_plugin "$SCENARIO_DIR/arms/$arm")
  if l5_smoke_mcp "$SMOKE_PLUGIN"; then
    printf "✓ MCP responds\n"
  else
    printf "✗ MCP smoke failed — see stderr\n"
    SMOKE_FAIL=1
  fi
  l5_cleanup_arm_plugin "$SMOKE_PLUGIN"
done
if [ "$SMOKE_FAIL" -ne 0 ]; then
  printf "\n❌ One or more arms failed MCP smoke. Aborting before token spend.\n"
  exit 1
fi
printf "\n"

# Run N pairs. Each pair runs all arms once.
PAIR_ID=$(date +%s)
for pair in $(seq 1 "$N"); do
  printf "--- Pair %d/%d ---\n" "$pair" "$N"
  for arm in $ARMS; do
    printf "  arm=%s: " "$arm"
    PROJECT=$(l5_setup_scratch_project)
    ARM_PLUGIN=$(l5_make_arm_plugin "$SCENARIO_DIR/arms/$arm")
    RUN_ID="ab-${SCENARIO_NAME}-pair${pair}-${arm}-${PAIR_ID}"

    # Apply scenario state (fixture + setup_files) BEFORE running claude.
    # Without this the scratch project lacks the files / DB rows the prompt
    # references — bro correctly responds 'nothing to do' and the test is moot.
    l5_setup_scenario_state "$PROJECT" "$SCENARIO_DIR"

    tmb_test_sandbox_init "$PROJECT"
    l5_run_arm "$PROJECT" "$ARM_PLUGIN" "$PROMPT"
    tmb_test_sandbox_teardown
    if PLUGIN_ROOT="$ARM_PLUGIN" l5_score_with_arm "$PROJECT" "$FLOW" "$SCORER_DIR" "$RUN_ID" "$arm" "$SCENARIO_NAME"; then
      printf "    ✓ all scorers passed\n"
    else
      printf "    ✗ at least one scorer failed\n"
    fi

    l5_cleanup_arm_plugin "$ARM_PLUGIN"
    l5_cleanup_project "$PROJECT"
  done
done

printf "\n=== Done — %d pairs × %d arms = %d total runs ===\n" "$N" "$(echo "$ARMS" | wc -l | tr -d ' ')" "$((N * $(echo "$ARMS" | wc -l | tr -d ' ')))"
printf "Run report:\n"
printf "  bash %s/scripts/ab-report.sh %s\n" "$HERE" "$SCENARIO_NAME"
