#!/usr/bin/env bash
# Tests for scripts/hooks/git-guards.sh
# Hook contract: block force-push to main, block direct commit on protected
# branches, block PRs not targeting the configured pr_target. Config-driven
# via plugin_config (branching_model / pr_target / protected_branches).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-guards.sh"

run_hook() {
  (cd "$PLUGIN_ROOT" && echo "$1" | CLAUDE_PLUGIN_DATA=/nonexistent bash "$HOOK" 2>&1 || true)
}

test_case "no config (fresh install) is non-blocking for commits"
out=$(run_hook '{"tool_input":{"command":"git commit -m test"}}')
assert_not_contains "$out" '"decision":"block"' "should NOT block on fresh install"

test_case "non-git command passes through"
out=$(run_hook '{"tool_input":{"command":"ls -la"}}')
assert_not_contains "$out" '"decision":"block"' "ls should not fire hook"

test_case "git status is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git status"}}')
assert_not_contains "$out" '"decision":"block"' "git status should pass"

test_case "git log is not gated (read-only)"
out=$(run_hook '{"tool_input":{"command":"git log --oneline -5"}}')
assert_not_contains "$out" '"decision":"block"' "git log should pass"

summarize
