#!/usr/bin/env bash
# L3 tests: hooks accept both raw and tmb:-prefixed role values.
# Regression guard for the prefix-mismatch class (#38).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"

# ---- require-task-spec: tmb:swe prefix is gated identically to bare swe ----

HOOK_RTS="$PLUGIN_ROOT/scripts/hooks/require-task-spec.sh"

TMPDIR_RTS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_RTS"' EXIT
DB_RTS="$TMPDIR_RTS/trajectory.db"
sqlite3 "$DB_RTS" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    spec_body TEXT
  );
  INSERT INTO tasks VALUES (1, 'pending', 'Do the thing.');
"

test_case "require-task-spec: tmb:swe prefix is treated as swe (blocked without task_id)"
out=$(echo '{"tool_input":{"subagent_type":"tmb:swe","prompt":"do the thing"}}' \
  | TRAJECTORY_DB_PATH="$DB_RTS" bash "$HOOK_RTS" 2>&1 || true)
assert_contains "$out" '"decision":"block"' "tmb:swe without task_id must be blocked"
assert_contains "$out" "SWE spawn requires task_id" "block reason cites missing task_id"

test_case "require-task-spec: tmb:swe prefix with valid task passes silently"
out=$(echo '{"tool_input":{"subagent_type":"tmb:swe","prompt":"task_id=1 do the thing"}}' \
  | TRAJECTORY_DB_PATH="$DB_RTS" bash "$HOOK_RTS" 2>&1 || true)
assert_eq "" "$out" "tmb:swe with valid task_id passes silently"

# ---- pr-reviewer-no-worktree: tmb:pr-reviewer prefix is denied for worktree ----

HOOK_PRW="$PLUGIN_ROOT/scripts/hooks/pr-reviewer-no-worktree.sh"

test_case "pr-reviewer-no-worktree: tmb:pr-reviewer with isolation=worktree is denied"
out=$(echo '{"tool_name":"Agent","tool_input":{"subagent_type":"tmb:pr-reviewer","isolation":"worktree"}}' \
  | bash "$HOOK_PRW" 2>&1 || true)
assert_contains "$out" "permissionDecision" "deny output emitted for tmb:pr-reviewer"
assert_contains "$out" "deny" "decision is deny for tmb:pr-reviewer"

test_case "pr-reviewer-no-worktree: tmb:pr-reviewer without isolation passes silently"
out=$(echo '{"tool_name":"Agent","tool_input":{"subagent_type":"tmb:pr-reviewer"}}' \
  | bash "$HOOK_PRW" 2>&1 || true)
assert_eq "" "$out" "tmb:pr-reviewer without isolation is silent allow"

summarize
