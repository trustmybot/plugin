#!/usr/bin/env bash
# Tests for scripts/hooks/auq-error-fallback-context.sh
# Hook contract: PostToolUse on AskUserQuestion. Detects error responses and
# injects headless-fallback additionalContext. Silent no-op for non-AUQ tools
# and successful AUQ responses.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/auq-error-fallback-context.sh"

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

# Test 1 — non-AUQ tool: exit 0, no stdout output
test_case "non-AUQ tool exits silently"
input=$(jq -nc '{tool_name: "Bash", tool_response: {exit_code: 0, stdout: "ok"}}')
out=$(run_hook "$input")
assert_eq "" "$out" "hook output for non-AUQ tool"

# Test 2 — AUQ success: exit 0, no stdout output
test_case "AUQ success exits silently"
input=$(jq -nc '{
  tool_name: "AskUserQuestion",
  tool_response: {
    is_error: false,
    answers: [{"questionId": "q1", "answer": "yes"}]
  }
}')
out=$(run_hook "$input")
assert_eq "" "$out" "hook output for AUQ success"

# Test 3 — AUQ error via is_error flag: emits fallback context
test_case "AUQ error via is_error flag emits fallback context"
input=$(jq -nc '{
  tool_name: "AskUserQuestion",
  tool_response: {is_error: true}
}')
out=$(run_hook "$input")
assert_contains "$out" "<<<TMB-AUQ-ERROR-FALLBACK>>>" "output contains opening sentinel"
assert_contains "$out" "tmb_headless-fallback" "output references headless-fallback skill"
assert_contains "$out" "Do NOT retry" "output includes no-retry instruction"

# Test 4 — AUQ error via content match: emits fallback context
test_case "AUQ error via content text match emits fallback context"
input=$(jq -nc '{
  tool_name: "AskUserQuestion",
  tool_response: {
    is_error: false,
    content: [{"type": "text", "text": "tool errored on both attempts"}]
  }
}')
out=$(run_hook "$input")
assert_contains "$out" "<<<TMB-AUQ-ERROR-FALLBACK>>>" "output contains opening sentinel"
assert_contains "$out" "tmb_headless-fallback" "output references headless-fallback skill"
assert_contains "$out" "Do NOT retry" "output includes no-retry instruction"

summarize
