#!/usr/bin/env bash
# L6 deterministic-trajectory test runner (issue #108).
#
# Drives real Claude Code through TMB workflows by pre-seeding DB state
# (skipping past AskUserQuestion forms), then asserting the resulting
# MCP/tool trajectory matches a flow's expected sequence from FLOWS.md.
#
# Usage:
#   bash tests/dogfood/run-l6.sh             # all flows
#   bash tests/dogfood/run-l6.sh onboarding  # one flow by name
#
# Requirements:
#   - CLAUDE_CODE_OAUTH_TOKEN env var (CC's headless auth token)
#   - claude in PATH
#   - sqlite3, jq
#
# Each flow lives in tests/dogfood/flows/<name>.test.sh and is
# self-contained: pre-seed → invoke → assert. Flows run in mktemp scratch
# dirs — no Docker needed; CI runners are already isolated VMs.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
FILTER="${1:-}"

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

PASS=0
FAIL=0
FAILED_FLOWS=()

for flow_script in "$HERE/flows"/*.test.sh; do
  [ -e "$flow_script" ] || continue
  flow_name=$(basename "$flow_script" .test.sh)

  if [ -n "$FILTER" ] && [[ "$flow_name" != *"$FILTER"* ]]; then
    continue
  fi

  printf "\n=== L6 flow: %s ===\n" "$flow_name"

  if PLUGIN_ROOT="$PLUGIN_ROOT" \
     CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" \
     bash "$flow_script"; then
    printf "  ✓ %s passed\n" "$flow_name"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s failed\n" "$flow_name"
    FAIL=$((FAIL + 1))
    FAILED_FLOWS+=("$flow_name")
  fi
done

printf "\n========================================\n"
printf "L6 dogfood: %d passed, %d failed\n" "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf "Failed flows: %s\n" "${FAILED_FLOWS[*]}"
  exit 1
fi
