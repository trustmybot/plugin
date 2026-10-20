#!/usr/bin/env bash
# Tests: scripts/hooks/lib/query-task.sh worktree → task resolution.
#   - two tasks share a slug under different types: the worktree's checked-out
#     branch matches exactly; a detached worktree gets the newest with a stderr
#     warning naming both
#   - `_` and `%` in a slug match literally, not as LIKE wildcards
#   - tmb_unsigned_tasks is gone
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
. "$PLUGIN_ROOT/scripts/hooks/lib/query-task.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/tmb-query-task-slug.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
TMP=$(cd "$TMP" && pwd -P)
REPO="$TMP/repo"
DB="$REPO/.claude/tmb/trajectory.db"
export TRAJECTORY_DB_PATH="$DB"

git init -q -b main "$REPO"
git -C "$REPO" config user.email t@t.t
git -C "$REPO" config user.name T
echo init > "$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -qm init
mkdir -p "$(dirname "$DB")"
sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
sqlite3 "$DB" "
  INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'o', 'd', 'open', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, created_at, updated_at) VALUES
    (1, 1, 'feat/shared-slug', 't1', 'd', 'running', '', '', ''),
    (2, 1, 'fix/shared-slug',  't2', 'd', 'running', '', '', ''),
    (3, 1, 'feat/axb',         't3', 'd', 'running', '', '', ''),
    (4, 1, 'feat/50xoff',      't4', 'd', 'running', '', '', ''),
    (5, 1, 'feat/a_b',         't5', 'd', 'running', '', '', '');
"

git -C "$REPO" branch -q feat/shared-slug
git -C "$REPO" worktree add -q "$REPO/.claude/worktrees/shared-slug" feat/shared-slug
DETACHED="$TMP/other/.claude/worktrees/shared-slug"
mkdir -p "$(dirname "$DETACHED")"
git -C "$REPO" worktree add -q --detach "$DETACHED"
git -C "$REPO" worktree add -q --detach "$REPO/.claude/worktrees/a_b"
git -C "$REPO" worktree add -q --detach "$REPO/.claude/worktrees/50%off"

test_case "shared slug, worktree on its branch: the exact branch_id wins over the newer task"
err=$(tmb_resolve_task_id_for_target "$REPO/.claude/worktrees/shared-slug/x.txt" "" "$DB" 2>&1 >/dev/null)
assert_eq "1" "$(tmb_resolve_task_id_for_target "$REPO/.claude/worktrees/shared-slug/x.txt" "" "$DB" 2>/dev/null)" "feat/shared-slug"
assert_eq "" "$err" "no ambiguity warning on an exact match"

test_case "shared slug, detached worktree: newest task, warning names both"
err=$(tmb_resolve_task_id_for_target "$DETACHED/x.txt" "" "$DB" 2>&1 >/dev/null)
assert_eq "2" "$(tmb_resolve_task_id_for_target "$DETACHED/x.txt" "" "$DB" 2>/dev/null)" "newest of the two"
assert_contains "$err" "matches 2 tasks" "stderr warning"
assert_contains "$err" "feat/shared-slug" "warning names the older match"
assert_contains "$err" "fix/shared-slug" "warning names the newer match"

test_case "_ in a slug is literal"
assert_eq "5" "$(tmb_resolve_task_id_for_target "$REPO/.claude/worktrees/a_b/x" "" "$DB" 2>/dev/null)" "a_b matches feat/a_b only, not feat/axb"
sqlite3 "$DB" "DELETE FROM tasks WHERE id = 5;"
assert_eq "" "$(tmb_resolve_task_id_for_target "$REPO/.claude/worktrees/a_b/x" "" "$DB" 2>/dev/null)" "with feat/a_b gone, feat/axb does not match"

test_case "% in a slug is literal"
assert_eq "" "$(tmb_resolve_task_id_for_target "$REPO/.claude/worktrees/50%off/x" "" "$DB" 2>/dev/null)" "50%off does not match feat/50xoff"

test_case "tmb_task_by_slug: branch_id column and status filter"
assert_eq "fix/shared-slug" "$(tmb_task_by_slug "$DB" shared-slug branch_id 2>/dev/null)" "branch_id of the newest"
sqlite3 "$DB" "UPDATE tasks SET status = 'closed' WHERE id = 2;"
assert_eq "1" "$(tmb_task_by_slug "$DB" shared-slug id "'pending','running'" 2>/dev/null)" "status filter narrows to the open task"
assert_eq "" "$(tmb_task_by_slug "$DB" shared-slug id "'running'); DROP TABLE tasks; --" 2>/dev/null)" "a status list outside the quoted-word shape is refused"
assert_eq "4" "$(sqlite3 "$DB" 'SELECT count(*) FROM tasks;' | tr -d ' ')" "tasks table intact"

test_case "tmb_unsigned_tasks is gone"
if declare -F tmb_unsigned_tasks >/dev/null; then _fail "tmb_unsigned_tasks still defined"; else _pass; fi

summarize
