#!/usr/bin/env bash
# Tests for scripts/hooks/auq-headless-deny.sh
# Hook contract: PreToolUse on AskUserQuestion. Blocks (deny) when TMB_HEADLESS=1.
# Silent no-op for non-AUQ tools and when TMB_HEADLESS is unset or 0.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/auq-headless-deny.sh"

run_hook() {
  local input="$1"
  shift
  echo "$input" | env "$@" bash "$HOOK" 2>&1 || true
}

make_input() {
  jq -nc --arg t "$1" '{tool_name: $t}'
}

# Test 1 — non-AUQ tool: exit 0, no stdout
test_case "non-AUQ tool exits silently"
input=$(make_input "Bash")
out=$(run_hook "$input")
assert_eq "" "$out" "hook output for non-AUQ tool"

# Test 2 — AUQ + TMB_HEADLESS unset: exit 0, no stdout
test_case "AUQ with TMB_HEADLESS unset exits silently"
input=$(make_input "AskUserQuestion")
out=$(env -u TMB_HEADLESS bash -c 'echo '"$(printf '%q' "$input")"' | bash '"$(printf '%q' "$HOOK")"'' 2>&1 || true)
assert_eq "" "$out" "hook output when TMB_HEADLESS unset"

# Test 3 — AUQ + TMB_HEADLESS=1: deny with fallback instructions
test_case "AUQ with TMB_HEADLESS=1 emits deny decision"
input=$(make_input "AskUserQuestion")
out=$(echo "$input" | TMB_HEADLESS=1 bash "$HOOK" 2>&1 || true)
assert_contains "$out" '"permissionDecision":"deny"' "output has deny decision"
assert_contains "$out" "tmb_recovery" "output references the recovery skill"
assert_contains "$out" "Skip retrying" "output includes no-retry instruction"

# Test 4 — AUQ + TMB_HEADLESS=0 (set but falsy): exit 0, no stdout
test_case "AUQ with TMB_HEADLESS=0 exits silently"
input=$(make_input "AskUserQuestion")
out=$(echo "$input" | TMB_HEADLESS=0 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "hook output when TMB_HEADLESS=0"

summarize
