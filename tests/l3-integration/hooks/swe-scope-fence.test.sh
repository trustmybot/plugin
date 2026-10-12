#!/usr/bin/env bash
# Tests for scripts/hooks/swe-scope-fence.sh
#
# Hook contract: never deny. An Edit/Write in an SWE worktree to a path
# outside the task's typed files[] dirs gets an additionalContext note
# "<path> is outside this task's files[] (<dirs>); list it and why in your
# report" — once per path per task. Scope is judged at close.
#
# Scenarios:
#   - in-scope edit (path under a listed dir) → silent
#   - out-of-scope edit → allowed, note names the path and the listed dirs
#   - the same path again → silent (deduped per task); another task → noted
#   - no-task, empty files[], non-worktree PWD, non-Edit tool → silent
#   - dir-granularity: file listed → its directory is the scope
#   - root-level file listed → only that exact file is in scope
#   - tests/ path in scope when files[] includes a tests/ parent
#   - the hook source carries no deny
#   - a path a heredoc program writes is noted by swe-boundary.sh through the
#     same classifier
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

# Typed files[] fixtures (JSON arrays — Typed Rails #673).
FILES_WITH_FILES='["scripts/hooks/my-hook.sh","tests/l3-integration/hooks/my-hook.test.sh"]'
FILES_MULTIDIR='["src/api/handler.ts","src/lib/util.ts","tests/unit/handler.test.ts"]'
FILES_EMPTY='[]'
FILES_ROOT_FILE='["Makefile"]'
FILES_TRAILING_SLASH='["tests/"]'

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
    prompt_bearing INTEGER NOT NULL DEFAULT 0,
    files TEXT NOT NULL DEFAULT '[]'
  );
  INSERT INTO issues VALUES (1, 'test', '', 'open', datetime('now'), datetime('now'));
  INSERT INTO tasks VALUES (1, 1, 'feat/task-alpha', 'running', '', 0, '$FILES_WITH_FILES');
  INSERT INTO tasks VALUES (2, 1, 'feat/task-beta', 'running', '', 0, '$FILES_MULTIDIR');
  INSERT INTO tasks VALUES (3, 1, 'feat/task-nofiles', 'running', '', 0, '$FILES_EMPTY');
  INSERT INTO tasks VALUES (5, 1, 'feat/task-rootfile', 'running', '', 0, '$FILES_ROOT_FILE');
  INSERT INTO tasks VALUES (6, 1, 'feat/task-trailingslash', 'running', '', 0, '$FILES_TRAILING_SLASH');
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

DENY='"permissionDecision":"deny"'

# ===========================================================================
# In-scope edits are silent
# ===========================================================================

test_case "in-scope: file directly in a listed dir is silent"
out=$(run_hook "$WT_A" "$(make_edit_input "scripts/hooks/my-hook.sh")")
assert_not_contains "$out" "$DENY" "in-scope edit is allowed"
assert_not_contains "$out" "outside this task" "in-scope edit carries no note"

test_case "in-scope: file nested under a listed dir is silent"
out=$(run_hook "$WT_A" "$(make_edit_input "scripts/hooks/subdir/helper.sh")")
assert_not_contains "$out" "outside this task" "nested file under a listed dir carries no note"

test_case "in-scope: Write tool (not just Edit) is silent"
out=$(run_hook "$WT_A" "$(make_write_input "scripts/hooks/new-file.sh")")
assert_not_contains "$out" "outside this task" "Write in scope carries no note"

test_case "tests/: a tests/ sibling is in scope when files[] lists a tests/ path"
out=$(run_hook "$WT_A" "$(make_edit_input "tests/l3-integration/hooks/other.test.sh")")
assert_not_contains "$out" "outside this task" "tests/ sibling carries no note"

# ===========================================================================
# Out-of-scope edits are allowed with a once-per-path note
# ===========================================================================

test_case "out-of-scope: Edit to an unrelated dir is allowed with a note"
out=$(run_hook "$WT_A" "$(make_edit_input "src/api/handler.ts")")
assert_not_contains "$out" "$DENY" "out-of-scope edit is allowed"
assert_contains "$out" "additionalContext" "the note is additionalContext"
assert_contains "$out" "src/api/handler.ts is outside this task's files[] (scripts/hooks, tests/l3-integration/hooks); list it and why in your report" "the note names the path and the listed dirs"

test_case "out-of-scope: the same path again is silent"
out=$(run_hook "$WT_A" "$(make_edit_input "src/api/handler.ts")")
assert_not_contains "$out" "outside this task" "a path is noted once per task"
out=$(run_hook "$WT_A" "$(make_write_input "$WT_A/src/api/handler.ts")")
assert_not_contains "$out" "outside this task" "the absolute form of the same path is the same path"

test_case "out-of-scope: another task notes the same path afresh"
out=$(run_hook "$WT_B" "$(make_edit_input "scripts/hooks/something.sh")")
assert_contains "$out" "scripts/hooks/something.sh is outside this task's files[]" "first write of this path for task beta"
out=$(run_hook "$WT_A" "$(make_edit_input "docs/README.md")")
assert_contains "$out" "docs/README.md is outside this task's files[]" "a new path for task alpha is noted"
assert_eq "$([ -d "$TMPDIR/locks/scope-notes/1" ] && [ -d "$TMPDIR/locks/scope-notes/2" ] && echo yes)" "yes" "markers live per task under the state dir's locks/"

# ===========================================================================
# Dir-granularity: file listed → directory is the scope
# ===========================================================================

test_case "dir-granularity: multi-dir spec — src/api/other.ts is in scope"
out=$(run_hook "$WT_B" "$(make_edit_input "src/api/other.ts")")
assert_not_contains "$out" "outside this task" "sibling in a listed dir carries no note"

test_case "root-file: the exact root file is in scope, another root file is noted"
WT_ROOTFILE="$WT_ROOT/task-rootfile"
mkdir -p "$WT_ROOTFILE"
out=$(run_hook "$WT_ROOTFILE" "$(make_edit_input "Makefile")")
assert_not_contains "$out" "outside this task" "the listed root file carries no note"
out=$(run_hook "$WT_ROOTFILE" "$(make_edit_input "package.json")")
assert_contains "$out" "package.json is outside this task's files[] (Makefile)" "another root file is noted"

test_case "trailing-slash: token 'tests/' covers tests/, notes the rest"
WT_TRAILINGSLASH="$WT_ROOT/task-trailingslash"
mkdir -p "$WT_TRAILINGSLASH"
out=$(run_hook "$WT_TRAILINGSLASH" "$(make_edit_input "tests/l3-integration/hooks/x.test.sh")")
assert_not_contains "$out" "outside this task" "tests/ is in scope"
out=$(run_hook "$WT_TRAILINGSLASH" "$(make_edit_input "src/api/handler.ts")")
assert_contains "$out" "src/api/handler.ts is outside this task's files[] (tests)" "a path outside tests/ is noted"

# ===========================================================================
# Silent cases
# ===========================================================================

WT_UNKNOWN="$WT_ROOT/no-such-task"
WT_NOFILES="$WT_ROOT/task-nofiles"
NON_WT_DIR="$TMPDIR/non-worktree"
mkdir -p "$WT_UNKNOWN" "$WT_NOFILES" "$NON_WT_DIR"

test_case "no-task: unknown worktree slug is silent"
out=$(run_hook "$WT_UNKNOWN" "$(make_edit_input "anything/file.ts")")
assert_eq "$out" "" "no output without a task row"

test_case "empty-files: task with empty typed files[] is silent"
out=$(run_hook "$WT_NOFILES" "$(make_edit_input "anything/file.ts")")
assert_eq "$out" "" "no output without files[]"

test_case "non-worktree: relative target with PWD outside a worktree is silent"
out=$( (cd "$NON_WT_DIR" && echo "$(make_edit_input "anything/file.ts")" | bash "$HOOK" 2>&1) || true)
assert_eq "$out" "" "no worktree, no note"

test_case "target-derived: absolute out-of-scope target resolves the worktree from the target (#597)"
out=$( (cd "$NON_WT_DIR" && echo "$(make_edit_input "$WT_A/lib/x.ts")" | bash "$HOOK" 2>&1) || true)
assert_contains "$out" "lib/x.ts is outside this task's files[]" "the worktree comes from the target"

test_case "non-edit-tool: Bash is ignored (swe-boundary.sh notes Bash writes)"
bash_input=$(jq -n '{"tool_name":"Bash","agent_type":"swe","tool_input":{"command":"echo x > elsewhere/y.ts"}}')
out=$(run_hook "$WT_A" "$bash_input")
assert_eq "$out" "" "Bash produces no output here"

test_case "GH 1279: a path a heredoc program writes outside files[] is noted once (swe-boundary.sh, same classifier)"
BOUNDARY_HOOK="$PLUGIN_ROOT/scripts/hooks/swe-boundary.sh"
heredoc_cmd=$(printf '%s\n' "python3 - <<'EOF'" "open('src/heredoc_out.py', 'w').write('x')" 'EOF')
bash_input=$(jq -n --arg c "$heredoc_cmd" '{"tool_name":"Bash","agent_type":"swe","tool_input":{"command":$c}}')
out=$( (cd "$WT_A" && echo "$bash_input" | bash "$BOUNDARY_HOOK" 2>&1) || true)
assert_not_contains "$out" "$DENY" "the note never denies"
assert_contains "$out" "src/heredoc_out.py is outside this task's files[] (scripts/hooks, tests/l3-integration/hooks)" "the extracted path is noted"
out=$( (cd "$WT_A" && echo "$bash_input" | bash "$BOUNDARY_HOOK" 2>&1) || true)
assert_not_contains "$out" "outside this task" "noted once per path"

test_case "DB read error: silent, never a deny"
out=$( (cd "$WT_A" && echo "$(make_edit_input "src/db-error.ts")" | TRAJECTORY_DB_PATH="$TMPDIR/not-a-db/trajectory.db" bash "$HOOK" 2>&1) || true)
assert_not_contains "$out" "$DENY" "a DB error never denies"

test_case "source: the hook carries no deny"
assert_not_contains "$(grep -v '^[[:space:]]*#' "$HOOK")" "permissionDecision" "swe-scope-fence.sh never decides"
assert_not_contains "$(grep -v '^[[:space:]]*#' "$HOOK")" "tmb_deny_db_unavailable" "swe-scope-fence.sh never fails closed"

summarize
