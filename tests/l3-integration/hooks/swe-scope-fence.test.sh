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
#   - no-task, empty files[], a target outside the worktree, no spawn
#     transcript, non-Edit tool → silent
#   - subtree rule (GH 1705): an entry covers itself and everything beneath
#     it, never its siblings
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

TMPDIR=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-swe-scope-fence.XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT

DB="$TMPDIR/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

# Fixture worktree directories.
WT_ROOT="$TMPDIR/.claude/worktrees"
WT_A="$WT_ROOT/task-alpha"
WT_B="$WT_ROOT/task-beta"
mkdir -p "$WT_A" "$WT_B"

# Typed files[] fixtures (JSON arrays — Typed Rails #673).
FILES_WITH_FILES='["scripts/hooks/","tests/l3-integration/hooks/my-hook.test.sh"]'
FILES_MULTIDIR='["src/api/","src/lib/util.ts","tests/unit/handler.test.ts"]'
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
  INSERT INTO tasks VALUES (7, 1, 'feat/allows-file', 'running', '', 0, '[\"src/a/b.ts\"]');
  INSERT INTO tasks VALUES (8, 1, 'feat/allows-dir', 'running', '', 0, '[\"src/a\"]');
  INSERT INTO tasks VALUES (9, 1, 'feat/allows-tests', 'running', '', 0, '[\"tests/l1/x.sh\"]');
  ALTER TABLE tasks ADD COLUMN repo TEXT;
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT);
  INSERT INTO repos VALUES ('proj', '$TMPDIR');
"

# spawn_transcript <task_id> — the swe's spawn transcript (task_id=<N> in its
# prompt), the only thing that identifies its task and worktree.
spawn_transcript() {
  local tf="$TMPDIR/spawn-$1.jsonl"
  printf '{"message":{"content":[{"type":"text","text":"task_id=%s"}]}}\n' "$1" > "$tf"
  printf '%s\n' "$tf"
}

# with_task <task_id> <input> — <input> as sent by the swe spawned for <task_id>.
with_task() {
  jq -c --arg t "$(spawn_transcript "$1")" '. + {agent_transcript_path: $t}' <<<"$2"
}

# run_hook <worktree> <input> — the swe of the task whose branch slug is the
# worktree's name (none for an unknown slug), its shell in that worktree.
run_hook() {
  local worktree="$1" input="$2" task
  task=$(sqlite3 "$DB" "SELECT id FROM tasks WHERE substr(branch_id, instr(branch_id, '/') + 1) = '${worktree##*/}' LIMIT 1;")
  [ -z "$task" ] || input=$(with_task "$task" "$input")
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
assert_contains "$out" "src/api/handler.ts is outside this task's files[] (scripts/hooks, tests/l3-integration/hooks/my-hook.test.sh); list it and why in your report" "the note names the path and the listed dirs"

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
# Subtree rule (GH 1705): an entry covers itself and its subtree, never siblings
# ===========================================================================

# allows <task_id> <path> — yes/no from tmb_scope_fence_allows after loading the task.
allows() {
  (
    # shellcheck source=/dev/null
    . "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"
    # shellcheck source=/dev/null
    . "$PLUGIN_ROOT/scripts/hooks/lib/scope-fence.sh"
    tmb_scope_fence_load "$DB" "$1"
    if tmb_scope_fence_allows "$2"; then echo yes; else echo no; fi
  )
}

test_case "subtree: tmb_scope_fence_allows matches pathInFiles"
assert_eq "$(allows 7 src/a/c.ts)" "no" "a file entry does not cover its sibling"
assert_eq "$(allows 7 src/a/b.ts)" "yes" "a file entry covers itself"
assert_eq "$(allows 8 src/a/x/y.ts)" "yes" "a dir entry covers its subtree"
assert_eq "$(allows 9 tests/z.sh)" "yes" "any tests/ entry covers all of tests/"

test_case "subtree: a listed dir covers its files, a listed file never its sibling"
out=$(run_hook "$WT_B" "$(make_edit_input "src/api/other.ts")")
assert_not_contains "$out" "outside this task" "a file under a listed dir carries no note"
out=$(run_hook "$WT_B" "$(make_edit_input "src/lib/other.ts")")
assert_contains "$out" "src/lib/other.ts is outside this task's files[]" "a sibling of a listed file is noted"

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

test_case "non-worktree: a relative target joins the cwd; outside the worktree is silent"
out=$( (cd "$NON_WT_DIR" && with_task 1 "$(make_edit_input "anything/file.ts")" | bash "$HOOK" 2>&1) || true)
assert_eq "$out" "" "outside the worktree, no note"

test_case "GH 1550: no spawn transcript is silent, whatever the cwd"
out=$( (cd "$WT_A" && echo "$(make_edit_input "$WT_A/lib/unidentified.ts")" | bash "$HOOK" 2>&1) || true)
assert_eq "$out" "" "a cwd inside a worktree is not identity"

test_case "identity-derived: absolute out-of-scope target, shell outside any worktree (#597)"
out=$( (cd "$NON_WT_DIR" && with_task 1 "$(make_edit_input "$WT_A/lib/x.ts")" | bash "$HOOK" 2>&1) || true)
assert_contains "$out" "lib/x.ts is outside this task's files[]" "the worktree comes from the task"

test_case "non-edit-tool: Bash is ignored (swe-boundary.sh notes Bash writes)"
bash_input=$(jq -n '{"tool_name":"Bash","agent_type":"swe","tool_input":{"command":"echo x > elsewhere/y.ts"}}')
out=$(run_hook "$WT_A" "$bash_input")
assert_eq "$out" "" "Bash produces no output here"

test_case "GH 1279: a path a heredoc program writes outside files[] is noted once (swe-boundary.sh, same classifier)"
BOUNDARY_HOOK="$PLUGIN_ROOT/scripts/hooks/swe-boundary.sh"
heredoc_cmd=$(printf '%s\n' "python3 - <<'EOF'" "open('src/heredoc_out.py', 'w').write('x')" 'EOF')
bash_input=$(with_task 1 "$(jq -n --arg c "$heredoc_cmd" '{"tool_name":"Bash","agent_type":"swe","tool_input":{"command":$c}}')")
out=$( (cd "$WT_A" && echo "$bash_input" | bash "$BOUNDARY_HOOK" 2>&1) || true)
assert_not_contains "$out" "$DENY" "the note never denies"
assert_contains "$out" "src/heredoc_out.py is outside this task's files[] (scripts/hooks, tests/l3-integration/hooks/my-hook.test.sh)" "the extracted path is noted"
out=$( (cd "$WT_A" && echo "$bash_input" | bash "$BOUNDARY_HOOK" 2>&1) || true)
assert_not_contains "$out" "outside this task" "noted once per path"

test_case "DB read error: silent, never a deny"
out=$( (cd "$WT_A" && with_task 1 "$(make_edit_input "src/db-error.ts")" | TRAJECTORY_DB_PATH="$TMPDIR/not-a-db/trajectory.db" bash "$HOOK" 2>&1) || true)
assert_not_contains "$out" "$DENY" "a DB error never denies"

test_case "source: the hook carries no deny"
assert_not_contains "$(grep -v '^[[:space:]]*#' "$HOOK")" "permissionDecision" "swe-scope-fence.sh never decides"
assert_not_contains "$(grep -v '^[[:space:]]*#' "$HOOK")" "tmb_deny_db_unavailable" "swe-scope-fence.sh never fails closed"

summarize
