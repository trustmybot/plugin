#!/usr/bin/env bash
# Tests for scripts/hooks/swe-scope-fence.sh
#
# Hook contract: deny edits outside the task's ## Files dirs in SWE worktrees.
#
# Scenarios:
#   - in-scope edit (path under an allowed dir) → passes
#   - out-of-scope edit → denied with allowed dirs + recovery message
#   - no-task (worktree slug not in DB) → passes (fail open)
#   - malformed ## Files section → passes (fail open)
#   - dir-granularity: file listed → its directory is the allowed scope
#   - root-level file listed → only that exact file is allowed (no dir promotion)
#   - tests/ path always allowed when ## Files includes a tests/ parent
#   - non-worktree PWD → passes (hook is not in SWE worktree context)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/swe-scope-fence.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

# Fixture worktree directories.
WT_ROOT="$TMPDIR/.claude/worktrees"
WT_A="$WT_ROOT/task-alpha"
WT_B="$WT_ROOT/task-beta"
mkdir -p "$WT_A" "$WT_B"

# Fixture spec bodies.
SPEC_WITH_FILES="## Description
Some task.

## Files
- scripts/hooks/my-hook.sh — new hook
- tests/l3-integration/hooks/my-hook.test.sh — tests

## Success Criteria
- Works
"

SPEC_MULTIDIR="## Description
Multi-dir task.

## Files
- src/api/handler.ts — new handler
- src/lib/util.ts — utility
- tests/unit/handler.test.ts — unit tests

## Success Criteria
- Works
"

SPEC_NO_FILES="## Description
Task with no files section.

## Success Criteria
- Works
"

SPEC_MALFORMED="## Description
Task.

## Files
This section has no bullet points, just prose.

## Success Criteria
- Works
"

SPEC_ROOT_FILE="## Description
Task.

## Files
- Makefile — build system

## Success Criteria
- Works
"

sqlite3 "$DB" "
  CREATE TABLE issues (
    id INTEGER PRIMARY KEY,
    objective TEXT NOT NULL DEFAULT 'test',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    issue_id INTEGER NOT NULL REFERENCES issues(id),
    branch_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    spec_body TEXT NOT NULL DEFAULT '',
    prompt_bearing INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks VALUES (1, 1, 'feat/task-alpha', 'running', '$(echo "$SPEC_WITH_FILES" | sed "s/'/''/g")', 0);
  INSERT INTO tasks VALUES (2, 1, 'feat/task-beta', 'running', '$(echo "$SPEC_MULTIDIR" | sed "s/'/''/g")', 0);
  INSERT INTO tasks VALUES (3, 1, 'feat/task-nofiles', 'running', '$(echo "$SPEC_NO_FILES" | sed "s/'/''/g")', 0);
  INSERT INTO tasks VALUES (4, 1, 'feat/task-malformed', 'running', '$(echo "$SPEC_MALFORMED" | sed "s/'/''/g")', 0);
  INSERT INTO tasks VALUES (5, 1, 'feat/task-rootfile', 'running', '$(echo "$SPEC_ROOT_FILE" | sed "s/'/''/g")', 0);
"

run_hook() {
  local worktree="$1"
  local input="$2"
  (cd "$worktree" && echo "$input" | bash "$HOOK" 2>&1 || true)
}

make_edit_input() {
  local path="$1"
  jq -n --arg p "$path" '{
    tool_name: "Edit",
    agent_type: "swe",
    tool_input: {file_path: $p}
  }'
}

make_write_input() {
  local path="$1"
  jq -n --arg p "$path" '{
    tool_name: "Write",
    agent_type: "swe",
    tool_input: {file_path: $p}
  }'
}

# ===========================================================================
# In-scope edits pass
# ===========================================================================

test_case "in-scope: file directly in an allowed dir passes"
out=$(run_hook "$WT_A" "$(make_edit_input "scripts/hooks/my-hook.sh")")
assert_not_contains "$out" '"permissionDecision":"deny"' "in-scope edit should pass"

test_case "in-scope: file nested under an allowed dir passes"
out=$(run_hook "$WT_A" "$(make_edit_input "scripts/hooks/subdir/helper.sh")")
assert_not_contains "$out" '"permissionDecision":"deny"' "nested file under allowed dir should pass"

test_case "in-scope: test file in allowed tests dir passes"
out=$(run_hook "$WT_A" "$(make_edit_input "tests/l3-integration/hooks/my-hook.test.sh")")
assert_not_contains "$out" '"permissionDecision":"deny"' "test file under allowed dir should pass"

test_case "in-scope: Write tool (not just Edit) passes"
out=$(run_hook "$WT_A" "$(make_write_input "scripts/hooks/new-file.sh")")
assert_not_contains "$out" '"permissionDecision":"deny"' "Write in-scope should pass"

# ===========================================================================
# Out-of-scope edits are denied
# ===========================================================================

test_case "out-of-scope: edit to unrelated dir is denied"
out=$(run_hook "$WT_A" "$(make_edit_input "src/api/handler.ts")")
assert_contains "$out" '"permissionDecision":"deny"' "out-of-scope edit should be denied"

test_case "out-of-scope: deny message names the allowed dirs"
out=$(run_hook "$WT_A" "$(make_edit_input "src/api/handler.ts")")
assert_contains "$out" "scripts/hooks" "deny should name allowed dirs"
assert_contains "$out" "tests/l3-integration/hooks" "deny should name test dir"

test_case "out-of-scope: deny message includes recovery instructions"
out=$(run_hook "$WT_A" "$(make_edit_input "hooks/hooks.json")")
assert_contains "$out" "bro" "deny message should mention asking bro"
assert_contains "$out" "follow-up task" "deny message should mention follow-up task"

test_case "out-of-scope: Write to unrelated file is denied"
out=$(run_hook "$WT_A" "$(make_write_input "docs/README.md")")
assert_contains "$out" '"permissionDecision":"deny"' "out-of-scope Write should be denied"

test_case "out-of-scope: multi-dir task, edit outside any listed dir denied"
out=$(run_hook "$WT_B" "$(make_edit_input "scripts/hooks/something.sh")")
assert_contains "$out" '"permissionDecision":"deny"' "edit outside all listed dirs should be denied"

# ===========================================================================
# Dir-granularity: file listed → directory is the scope
# ===========================================================================

test_case "dir-granularity: sibling file in same dir as listed file passes"
out=$(run_hook "$WT_A" "$(make_edit_input "scripts/hooks/another-hook.sh")")
assert_not_contains "$out" '"permissionDecision":"deny"' "sibling in same dir should pass"

test_case "dir-granularity: multi-dir spec — src/api/other.ts passes (same dir as listed)"
out=$(run_hook "$WT_B" "$(make_edit_input "src/api/other.ts")")
assert_not_contains "$out" '"permissionDecision":"deny"' "sibling in listed dir should pass"

test_case "dir-granularity: multi-dir spec — src/lib/other.ts passes"
out=$(run_hook "$WT_B" "$(make_edit_input "src/lib/other.ts")")
assert_not_contains "$out" '"permissionDecision":"deny"' "file in listed dir should pass"

# ===========================================================================
# tests/ paths always allowed when ## Files lists a tests/ parent
# ===========================================================================

test_case "tests-always-allowed: tests/ sibling passes when tests/ parent listed"
out=$(run_hook "$WT_A" "$(make_edit_input "tests/l3-integration/hooks/other.test.sh")")
assert_not_contains "$out" '"permissionDecision":"deny"' "tests/ sibling under listed tests/ dir should pass"

# ===========================================================================
# No-task (worktree slug not in DB) → fail open
# ===========================================================================

WT_UNKNOWN="$WT_ROOT/no-such-task"
mkdir -p "$WT_UNKNOWN"

test_case "no-task: unknown worktree slug passes (fail open)"
out=$(run_hook "$WT_UNKNOWN" "$(make_edit_input "anything/file.ts")")
assert_not_contains "$out" '"permissionDecision":"deny"' "unknown task should fail open"

# ===========================================================================
# ## Files absent or unparseable → fail open
# ===========================================================================

WT_NOFILES="$WT_ROOT/task-nofiles"
WT_MALFORMED="$WT_ROOT/task-malformed"
mkdir -p "$WT_NOFILES" "$WT_MALFORMED"

test_case "no-files-section: task without ## Files passes (fail open)"
out=$(run_hook "$WT_NOFILES" "$(make_edit_input "anything/file.ts")")
assert_not_contains "$out" '"permissionDecision":"deny"' "task without ## Files should fail open"

test_case "malformed-files: ## Files section with no bullets passes (fail open)"
out=$(run_hook "$WT_MALFORMED" "$(make_edit_input "anything/file.ts")")
assert_not_contains "$out" '"permissionDecision":"deny"' "malformed ## Files should fail open"

# ===========================================================================
# Root-level file listed → exact path only (no dir promotion)
# ===========================================================================

WT_ROOTFILE="$WT_ROOT/task-rootfile"
mkdir -p "$WT_ROOTFILE"

test_case "root-file: editing the exact root file passes"
out=$(run_hook "$WT_ROOTFILE" "$(make_edit_input "Makefile")")
assert_not_contains "$out" '"permissionDecision":"deny"' "editing the exact root file should pass"

test_case "root-file: editing a different root file is denied"
out=$(run_hook "$WT_ROOTFILE" "$(make_edit_input "package.json")")
assert_contains "$out" '"permissionDecision":"deny"' "editing a different root file should be denied"

# ===========================================================================
# Non-worktree PWD → hook is inactive (not in SWE worktree context)
# ===========================================================================

NON_WT_DIR="$TMPDIR/non-worktree"
mkdir -p "$NON_WT_DIR"

test_case "non-worktree: hook passes through when PWD is not a worktree"
out=$((cd "$NON_WT_DIR" && echo "$(make_edit_input "anything/file.ts")" | bash "$HOOK" 2>&1) || true)
assert_not_contains "$out" '"permissionDecision":"deny"' "non-worktree PWD should not be blocked"

# ===========================================================================
# Non-Edit/Write tools are ignored
# ===========================================================================

test_case "non-edit-tool: Bash tool is ignored"
bash_input=$(jq -n '{"tool_name":"Bash","agent_type":"swe","tool_input":{"command":"ls"}}')
out=$(run_hook "$WT_A" "$bash_input")
assert_not_contains "$out" '"permissionDecision":"deny"' "Bash tool should not be blocked by scope fence"

summarize
