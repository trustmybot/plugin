#!/usr/bin/env bash
# Tests for scripts/hooks/pr-reviewer-no-worktree.sh.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/pr-reviewer-no-worktree.sh"

# pr-reviewer with isolation=worktree → deny.
test_case "pr-reviewer with isolation=worktree is denied"
out=$(echo '{"tool_name":"Agent","tool_input":{"subagent_type":"pr-reviewer","isolation":"worktree"}}' | bash "$HOOK" 2>&1 || true)
assert_contains "$out" "permissionDecision" "deny output emitted"
assert_contains "$out" "deny" "decision is deny"
assert_contains "$out" "must NOT run with isolation" "reason explains workflow"

# pr-reviewer without isolation → allow (silent).
test_case "pr-reviewer without isolation is allowed"
out=$(echo '{"tool_name":"Agent","tool_input":{"subagent_type":"pr-reviewer"}}' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "silent allow"

# pr-reviewer with isolation=none → allow.
test_case "pr-reviewer with isolation=none is allowed"
out=$(echo '{"tool_name":"Agent","tool_input":{"subagent_type":"pr-reviewer","isolation":"none"}}' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "silent allow"

# SWE with isolation=worktree → allow (this hook only targets pr-reviewer).
test_case "swe with isolation=worktree is allowed (hook only targets pr-reviewer)"
out=$(echo '{"tool_name":"Agent","tool_input":{"subagent_type":"swe","isolation":"worktree"}}' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "silent allow for swe"

# Non-Agent tool → silent no-op.
test_case "non-Agent tool is silent no-op"
out=$(echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' | bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "silent no-op"

# Bypass via env var → allow.
test_case "TMB_ALLOW_PR_REVIEWER_WORKTREE=1 bypasses the deny"
out=$(echo '{"tool_name":"Agent","tool_input":{"subagent_type":"pr-reviewer","isolation":"worktree"}}' | TMB_ALLOW_PR_REVIEWER_WORKTREE=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass works"

summarize
