#!/usr/bin/env bash
# Tests for scripts/hooks/git-push-guard.sh — rebased task commits whose
# generated dist was rebuilt (GH 1627).
#
# feat/t holds task 7's reviewed commit TSHA (src/t.ts plus
# mcp/trajectory-server/dist/index.js), cut from origin/main. main has moved
# on; feat/t-rebased replays TSHA onto main and rebuilds the dist file, so
# REBASED keeps TSHA's source change but not its patch-id.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/git-push-guard.sh"

DIST=mcp/trajectory-server/dist/index.js

commit_files() {
  local msg="$1"; shift
  local f
  for f in "$@"; do
    mkdir -p "$REPO_PATH/$(dirname "$f")"
    printf '%s %s\n' "$msg" "$f" >> "$REPO_PATH/$f"
  done
  git -C "$REPO_PATH" add -- "$@"
  git -C "$REPO_PATH" commit -qm "$msg"
  git -C "$REPO_PATH" rev-parse HEAD
}

setup_repo() {
  REPO_PATH=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-push-guard-dist-XXXXXX")
  git -C "$REPO_PATH" init -q -b main
  git -C "$REPO_PATH" config user.email "test@example.com"
  git -C "$REPO_PATH" config user.name "Test"
  git -C "$REPO_PATH" init --bare -q upstream.git
  git -C "$REPO_PATH" remote add origin "$REPO_PATH/upstream.git"
  commit_files "init" README.md src/base.ts "$DIST" >/dev/null
  git -C "$REPO_PATH" push -qu origin main

  db="$REPO_PATH/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$db")"
  sqlite3 "$db" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null
  sqlite3 "$db" ".timeout 5000" "INSERT INTO issues (id, objective, description, status, created_at, updated_at)
    VALUES (1, 'test', 'test', 'open', datetime('now'), datetime('now'));" >/dev/null
}

insert_task() {
  local task_id="$1" sha="$2"
  sqlite3 "$db" ".timeout 5000" "INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, created_at, updated_at)
    VALUES ($task_id, 1, 'feat/t-$task_id', 'task $task_id', 'd', 'closed', '## body', '$sha', datetime('now'), datetime('now'));" >/dev/null
}

sign_task() {
  sqlite3 "$db" ".timeout 5000" "INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
    VALUES ($1, 1, 'pr-reviewer', 'pass', 1, 'LGTM', datetime('now'));" >/dev/null
}

record_run() {
  local sha="$1" rc="$2" timed_out="${3:-0}"
  sqlite3 "$db" ".timeout 5000" "INSERT INTO verification_runs (task_id, commit_sha, source, started_at, finished_at, exit_code, budget_s, timed_out)
    VALUES (7, '$sha', 'gate', '2026-10-21T00:00:00.000Z', '2026-10-21T00:01:00.000Z', $rc, 900, $timed_out);" >/dev/null
}

# setup_rebased <task files...> — task 7's commit touches the given files on
# feat/t; feat/t-rebased replays it onto a moved main and rebuilds $DIST.
setup_rebased() {
  setup_repo
  commit_files "base moved" src/base.ts "$DIST" >/dev/null
  git -C "$REPO_PATH" checkout -q -b feat/t origin/main
  TSHA=$(commit_files "feat: T" "$@")
  git -C "$REPO_PATH" checkout -q -b feat/t-rebased main
  git -C "$REPO_PATH" cherry-pick -X theirs "$TSHA" >/dev/null 2>&1
  printf 'rebuilt\n' >> "$REPO_PATH/$DIST"
  git -C "$REPO_PATH" add -- "$DIST"
  git -C "$REPO_PATH" commit -q --amend --no-edit
  REBASED=$(git -C "$REPO_PATH" rev-parse HEAD)
  insert_task 7 "$TSHA"
  sign_task 7
}

run_hook() {
  local payload
  payload=$(jq -cn --arg c "$1" '{tool_input:{command:$c}}')
  (cd "$REPO_PATH" && printf '%s' "$payload" | TRAJECTORY_DB_PATH="$db" bash "$HOOK" 2>&1 || true)
}

cleanup() {
  [ -n "${REPO_PATH:-}" ] && [ -d "$REPO_PATH" ] && rm -rf "$REPO_PATH"
  REPO_PATH=""
}

test_case "fixture: the rebuilt rebase keeps the source change but not the patch-id"
setup_rebased src/t.ts "$DIST"
assert_eq "$(git -C "$REPO_PATH" diff "$TSHA" "$REBASED" -- src/t.ts)" "" "src/t.ts is unchanged by the rebase"
full_a=$(git -C "$REPO_PATH" diff-tree -p "$TSHA" | git -C "$REPO_PATH" patch-id --stable | cut -d' ' -f1)
full_b=$(git -C "$REPO_PATH" diff-tree -p "$REBASED" | git -C "$REPO_PATH" patch-id --stable | cut -d' ' -f1)
[ -n "$full_a" ] && [ "$full_a" != "$full_b" ] && same=no || same=yes
assert_eq "$same" "no" "the full patch-ids differ"
cleanup

test_case "GH 1627: rebase with regenerated dist and no verification run → BLOCKED"
setup_rebased src/t.ts "$DIST"
out=$(run_hook "git push origin feat/t-rebased")
assert_contains "$out" '"permissionDecision":"deny"' "an unverified rebase with rebuilt dist must block"
assert_contains "$out" "$REBASED" "the deny names the rebased SHA"
assert_contains "$out" "task_id=7" "the deny names the task"
assert_contains "$out" "regenerated dist" "the deny says the dist was regenerated"
assert_contains "$out" "integrate.sh" "the deny points at integrate.sh"
cleanup

test_case "GH 1627: the same rebase after a passing verification run on its SHA → allowed"
setup_rebased src/t.ts "$DIST"
record_run "$REBASED" 0
out=$(run_hook "git push origin feat/t-rebased")
assert_not_contains "$out" '"permissionDecision":"deny"' "a passing run on the rebased SHA covers it"
cleanup

test_case "GH 1627: a failing run on the rebased SHA → BLOCKED"
setup_rebased src/t.ts "$DIST"
record_run "$REBASED" 1
out=$(run_hook "git push origin feat/t-rebased")
assert_contains "$out" '"permissionDecision":"deny"' "a failing run does not cover the rebase"
cleanup

test_case "GH 1627: a timed-out run on the rebased SHA → BLOCKED"
setup_rebased src/t.ts "$DIST"
record_run "$REBASED" 0 1
out=$(run_hook "git push origin feat/t-rebased")
assert_contains "$out" '"permissionDecision":"deny"' "a timed-out run does not cover the rebase"
cleanup

test_case "GH 1627: a passing run on the original task SHA does not cover the rebase"
setup_rebased src/t.ts "$DIST"
record_run "$TSHA" 0
out=$(run_hook "git push origin feat/t-rebased")
assert_contains "$out" '"permissionDecision":"deny"' "the run must name the pushed SHA"
cleanup

test_case "GH 1627: a source-only task commit rebased with a dist rebuild added → BLOCKED"
setup_rebased src/t.ts
out=$(run_hook "git push origin feat/t-rebased")
assert_contains "$out" '"permissionDecision":"deny"' "a changed path set still pairs on source paths"
assert_contains "$out" "task_id=7" "the deny names the task"
cleanup

test_case "GH 1627: an unreviewed task's rebuilt rebase → BLOCKED even with a passing run"
setup_rebased src/t.ts "$DIST"
sqlite3 "$db" ".timeout 5000" "DELETE FROM validation_attempts WHERE task_id = 7;" >/dev/null
record_run "$REBASED" 0
out=$(run_hook "git push origin feat/t-rebased")
assert_contains "$out" '"permissionDecision":"deny"' "an unreviewed task's rebase must block"
assert_contains "$out" "no passing review" "the deny says the task is unreviewed"
cleanup

test_case "GH 1627: a different source change with rebuilt dist stays untracked → allowed"
setup_rebased src/t.ts "$DIST"
git -C "$REPO_PATH" checkout -q -b feat/u main
commit_files "feat: U" src/t.ts "$DIST" >/dev/null
out=$(run_hook "git push origin feat/u")
assert_not_contains "$out" '"permissionDecision":"deny"' "no source-only match keeps today's behaviour"
cleanup

test_case "GH 1627: a dist-only commit with no task stays untracked → allowed"
setup_rebased src/t.ts "$DIST"
git -C "$REPO_PATH" checkout -q -b chore/dist main
commit_files "chore: rebuild dist" "$DIST" >/dev/null
out=$(run_hook "git push origin chore/dist")
assert_not_contains "$out" '"permissionDecision":"deny"' "a dist-only commit matches no task"
cleanup

test_case "GH 1627: an empty source patch never matches a dist-only task commit → allowed"
setup_repo
git -C "$REPO_PATH" checkout -q -b chore/dist-task origin/main
insert_task 8 "$(commit_files "chore: dist task" "$DIST" dashboard/dist/app.js)"
sign_task 8
git -C "$REPO_PATH" checkout -q -b chore/dist main
commit_files "chore: other dist" "$DIST" dashboard/dist/app.js >/dev/null
out=$(run_hook "git push origin chore/dist")
assert_not_contains "$out" '"permissionDecision":"deny"' "two dist-only commits share no source patch-id"
cleanup

summarize
