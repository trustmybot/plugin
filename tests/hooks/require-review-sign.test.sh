#!/usr/bin/env bash
# Tests for scripts/hooks/require-review-sign.sh (DB-only, Phase 6.5)
# Hook contract: block push/merge to protected branches if any completed
# task lacks PR Reviewer sign-off. feature/*/fix/*/refactor/* etc. allowed
# unconditionally (issue #13, PR #18). No more XML fallback (dropped in
# Phase 6.5 commit f745001).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/require-review-sign.sh"

run_hook() {
  (cd "$PLUGIN_ROOT" && echo "$1" | CLAUDE_PLUGIN_DATA=/nonexistent bash "$HOOK" 2>&1 || true)
}

test_case "non-push/merge command passes silently"
out=$(run_hook '{"tool_input":{"command":"git status"}}')
assert_eq "" "$out" "no output for non-gated command"

test_case "push to feature/* branch is allowed (#13)"
out=$(run_hook '{"tool_input":{"command":"git push origin feature/test-backup"}}')
assert_not_contains "$out" '"decision":"block"' "feature/ push should pass"

test_case "push to fix/* branch is allowed"
out=$(run_hook '{"tool_input":{"command":"git push origin fix/some-bug"}}')
assert_not_contains "$out" '"decision":"block"' "fix/ push should pass"

test_case "push to refactor/* branch is allowed"
out=$(run_hook '{"tool_input":{"command":"git push origin refactor/db-schema"}}')
assert_not_contains "$out" '"decision":"block"' "refactor/ push should pass"

test_case "push to chore/* branch is allowed"
out=$(run_hook '{"tool_input":{"command":"git push origin chore/cleanup"}}')
assert_not_contains "$out" '"decision":"block"' "chore/ push should pass"

test_case "push to docs/* branch is allowed"
out=$(run_hook '{"tool_input":{"command":"git push origin docs/update"}}')
assert_not_contains "$out" '"decision":"block"' "docs/ push should pass"

test_case "missing DB with push-to-random-branch does not crash"
out=$(run_hook '{"tool_input":{"command":"git push origin some-random-branch"}}')
assert_not_contains "$out" 'fatal' "no fatal error on missing DB"

summarize
