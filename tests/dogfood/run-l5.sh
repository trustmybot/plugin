#!/usr/bin/env bash
# L5 v2 multi-scorer test runner (issue #110, supersedes #108 v1).
#
# Industry-standard agentic evals: each flow gets graded by multiple
# scorers (outcome / trajectory / cost / optionally LLM-judge) instead
# of strict trajectory matching. See docs/contributing/EVALS.md and the
# per-flow README.md files for details.
#
# Usage:
#   bash tests/dogfood/run-l5.sh             # all flows
#   bash tests/dogfood/run-l5.sh onboarding  # one flow by name
#
# Requirements:
#   - CLAUDE_CODE_OAUTH_TOKEN env var (or active CC session in macOS keychain)
#   - claude in PATH
#   - sqlite3, jq

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
FILTER="${1:-}"
export PLUGIN_ROOT

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n"
  printf "   For local runs: export CLAUDE_CODE_OAUTH_TOKEN=...\n"
  printf "   For CI: configure as a repo secret (Settings → Secrets).\n"
  exit 1
fi

for cmd in claude sqlite3 jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "❌ %s not found in PATH.\n" "$cmd"
    exit 1
  fi
done

# ----- Pre-flight substrate health (#131 hardening) -----
# Soft diagnostics from the original #116 fix were quiet about hard failures —
# tests would proceed and waste tokens against a broken substrate. Now we
# fail-fast: any L0-L4-class issue (MCP can't spawn, schema parse error,
# auth dead, plugin tree broken) aborts before the first claude flow runs.
. "$HERE/lib/smoke-helpers.sh"
l5_pre_flight_or_abort "$PLUGIN_ROOT"

printf "=== claude --version (informational) ===\n"
claude --version 2>&1 | sed 's/^/  /' || echo "  ✗ claude --version failed"
printf "\n"

PASS=0
FAIL=0
FAILED_FLOWS=()

for flow_dir in "$HERE/flows"/*/; do
  [ -d "$flow_dir" ] || continue
  flow_name=$(basename "$flow_dir")
  run_script="$flow_dir/run.sh"

  [ -f "$run_script" ] || continue

  if [ -n "$FILTER" ] && [[ "$flow_name" != *"$FILTER"* ]]; then
    continue
  fi

  printf "\n=== L5 flow: %s ===\n" "$flow_name"

  if RUN_ID="${RUN_ID:-$(date +%s)-$$}-${flow_name}" \
     CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
     bash "$run_script"; then
    printf "  ✓ %s passed\n" "$flow_name"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s failed\n" "$flow_name"
    FAIL=$((FAIL + 1))
    FAILED_FLOWS+=("$flow_name")
  fi
done

printf "\n========================================\n"
printf "L5 dogfood: %d passed, %d failed\n" "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf "Failed flows: %s\n" "${FAILED_FLOWS[*]}"
  exit 1
fi
