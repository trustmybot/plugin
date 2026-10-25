#!/usr/bin/env bash
# Tests for skills/tmb_planning/scripts/integrate.sh (GH 1518): bro's
# post-review rebase of a task's branch in a temporary worktree.
#
# Each case builds a temp repo (main + the task branch feat/x-1) and a
# trajectory DB holding task 1 with a passing review for its commit_sha, then
# runs `integrate.sh 1 <base>` and checks the exit code, the SHA it prints, the
# branch ref, the verification_runs rows and that no temporary worktree is left.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SCRIPT="$PLUGIN_ROOT/skills/tmb_planning/scripts/integrate.sh"
GUARDS="$PLUGIN_ROOT/scripts/hooks/git-guards.sh"

PASSING='["test -f a.txt", "test -f m.txt"]'
FAILING='["test -f a.txt", "echo broken; exit 7"]'

g() { git -C "$REPO" "$@"; }

commit_file() {
  local file="$1" content="$2" msg="${3:-feat: $1}"
  printf '%s\n' "$content" > "$REPO/$file"
  g add "$file"
  g commit -qm "$msg"
}

# setup <main-move: none|clean|conflict|same> [<verification json>]
# main gets README (BASE0); feat/x-1 adds a.txt (COMMIT); then main moves:
#   clean    — m.txt
#   conflict — a.txt with other content
#   same     — the task's exact a.txt change (a rebase drops the task commit)
setup() {
  local move="$1" verification="${2:-$PASSING}"
  REPO=$(cd "$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-integrate-XXXXXX")" && pwd -P)
  g init -q -b main
  g config user.email test@example.com
  g config user.name Test
  commit_file README.md init
  BASE0=$(g rev-parse HEAD)
  g checkout -q -b feat/x-1
  commit_file a.txt task
  COMMIT=$(g rev-parse HEAD)
  g checkout -q main
  case "$move" in
    clean) commit_file m.txt moved ;;
    conflict) commit_file a.txt other ;;
    same) commit_file a.txt task "chore: land a.txt on main" ;;
  esac

  DB="$REPO/.claude/tmb/trajectory.db"
  mkdir -p "$(dirname "$DB")"
  if ! sqlite3 "$DB" < "$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql" >/dev/null; then
    _fail "schema load into $DB"
  fi
  if ! sqlite3 "$DB" "
    INSERT INTO repos (name, path, target_branch, branching_model, protected_branches)
      VALUES ('repo', '$REPO', 'main', 'github-flow', '[\"main\"]');
    INSERT INTO issues (id, objective, description, status, created_at, updated_at)
      VALUES (1, 'test', 'test', 'open', '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
    INSERT INTO tasks (id, issue_id, branch_id, title, description, status, spec_body, commit_sha, repo, verification, created_at, updated_at)
      VALUES (1, 1, 'feat/x-1', 'task 1', 'd', 'closed', '## body', '$COMMIT', 'repo', '$verification',
              '2026-10-19T00:00:00.000Z', '2026-10-19T00:00:00.000Z');
    INSERT INTO audit (issue_id, branch_id, from_node, event_type, summary, content_json, created_at)
      VALUES (1, 'feat/x-1', 'bro', 'bro_verification_pass', 'v', '{\"task_id\":1,\"commit_sha\":\"$COMMIT\"}', '2026-10-19T01:00:00.000Z');
    INSERT INTO validation_attempts (task_id, attempt_n, agent, verdict, mcp_available, feedback, created_at)
      VALUES (1, 1, 'pr-reviewer', 'pass', 1, 'LGTM', '2026-10-19T02:00:00.000Z');
  " >/dev/null; then
    _fail "seed of task 1 into $DB"
  fi
}

# integrate <base> — sets OUT (stdout), ERR (stderr) and RC.
integrate() {
  local errf
  errf=$(mktemp "$REPO/.claude/tmb/err.XXXXXX")
  RC=0
  OUT=$(cd "$REPO" && TRAJECTORY_DB_PATH="$DB" bash "$SCRIPT" 1 "$1" 2>"$errf") || RC=$?
  ERR=$(cat "$errf")
  rm -f "$errf"
}

q() { sqlite3 "$DB" "$1"; }

assert_no_temp_worktree() {
  assert_eq "1" "$(g worktree list --porcelain | grep -c '^worktree ')" "worktrees after the run"
  assert_eq "" "$(find "$REPO/.claude/worktrees" -mindepth 1 -maxdepth 1 -name 'integrate-*' 2>/dev/null)" "integrate-* dirs left behind"
}

cleanup() {
  [ -n "${REPO:-}" ] && rm -rf "$REPO"
  REPO=""
}

test_case "clean rebase: records a passing manual run on the new SHA and moves the branch"
setup clean
integrate main
assert_exit_code 0 "$RC" "integrate.sh exit ($ERR)"
NEW="$OUT"
assert_eq "$NEW" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "$(g rev-parse main)" "$(g rev-parse "$NEW^")" "the rebased commit's parent is main"
if [ "$NEW" != "$COMMIT" ]; then _pass; else _fail "the printed SHA is the original commit"; fi
assert_eq "1" "$(q "SELECT COUNT(*) FROM verification_runs WHERE commit_sha = '$NEW';")" "verification_runs rows for the new SHA"
assert_eq "1|manual|0|0" "$(q "SELECT task_id || '|' || source || '|' || exit_code || '|' || timed_out FROM verification_runs WHERE commit_sha = '$NEW';")" "the run row"
assert_eq "2" "$(q "SELECT COUNT(*) FROM verification_run_commands c JOIN verification_runs r ON r.id = c.run_id WHERE r.commit_sha = '$NEW' AND c.exit_code = 0;")" "both commands recorded as passing"
assert_eq "$COMMIT" "$(q "SELECT commit_sha FROM tasks WHERE id = 1;")" "tasks.commit_sha keeps the reviewed commit"
assert_no_temp_worktree
cleanup

test_case "conflict: exit 2, branch and verification_runs unchanged"
setup conflict
integrate main
assert_exit_code 2 "$RC" "integrate.sh exit ($ERR)"
assert_eq "" "$OUT" "nothing on stdout"
assert_contains "$ERR" "conflicted" "stderr names the conflict"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

test_case "patch drift: the task's change already on main → exit 2, nothing recorded"
setup same
integrate main
assert_exit_code 2 "$RC" "integrate.sh exit ($ERR)"
assert_contains "$ERR" "patch" "stderr names the patch-id mismatch"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

# setup_stacked — feat/parent adds p.txt; feat/x-1 is cut from it and adds
# a.txt (COMMIT); main squash-merges feat/parent, then adds m.txt (GH 1666).
setup_stacked() {
  setup none
  g branch -q -D feat/x-1
  g checkout -q -b feat/parent
  commit_file p.txt parent
  g checkout -q -b feat/x-1
  commit_file a.txt task
  COMMIT=$(g rev-parse HEAD)
  g checkout -q main
  g merge -q --squash feat/parent >/dev/null
  g commit -qm "feat: parent (squash)"
  commit_file m.txt moved
  q "UPDATE tasks SET commit_sha = '$COMMIT';
     UPDATE audit SET content_json = '{\"task_id\":1,\"commit_sha\":\"$COMMIT\"}';"
}

test_case "stacked on a squash-merged parent branch: not drift, exit 0 (GH 1666)"
setup_stacked
integrate main
assert_exit_code 0 "$RC" "integrate.sh exit ($ERR)"
NEW="$OUT"
assert_eq "$(g rev-parse main)" "$(g rev-parse "$NEW^" 2>/dev/null)" "the rebased commit's parent is main"
assert_eq "a.txt" "$(g diff "$NEW^" "$NEW" --name-only 2>/dev/null)" "the rebased commit changes only a.txt"
assert_eq "$NEW" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "1|manual|0" "$(q "SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE commit_sha = '$NEW';")" "a passing manual run on the printed SHA"
assert_no_temp_worktree
cleanup

test_case "failing verification: exit 1, the failing run is recorded, branch unmoved"
setup clean "$FAILING"
integrate main
assert_exit_code 1 "$RC" "integrate.sh exit ($ERR)"
assert_eq "" "$OUT" "nothing on stdout"
assert_contains "$ERR" "echo broken; exit 7" "stderr names the failing command"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "1|manual|7" "$(q "SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE task_id = 1 AND commit_sha <> '$COMMIT';")" "one failing manual run on the rebased SHA"
assert_eq "7" "$(q "SELECT exit_code FROM verification_run_commands WHERE ordinal = 2;")" "the failing command's row"
assert_no_temp_worktree
cleanup

# The second command runs in the temp worktree <repo>/.claude/worktrees/integrate-1.*,
# so ../../tmb is <repo>/.claude/tmb.
SLOW='["test -f a.txt", "touch ../../tmb/cmd-started; sleep 2"]'

# integrate_signalled <signal> — runs `integrate.sh 1 main` as its own job (set -m,
# so a background INT is not ignored), sends <signal> to its pid alone once the
# slow command has started, and sets RC.
integrate_signalled() {
  local pid i
  set -m
  (cd "$REPO" && TRAJECTORY_DB_PATH="$DB" exec bash "$SCRIPT" 1 main >/dev/null 2>&1) &
  pid=$!
  set +m
  for ((i = 0; i < 100; i++)); do
    [ -e "$REPO/.claude/tmb/cmd-started" ] && break
    sleep 0.1
  done
  kill "-$1" "$pid"
  RC=0
  wait "$pid" || RC=$?
}

for SIG_RC in TERM:143 INT:130; do
  SIG="${SIG_RC%%:*}"
  WANT="${SIG_RC##*:}"
  test_case "$SIG during a verification command: exit $WANT, the run finished as $WANT, temp worktree removed (GH 1814)"
  setup clean "$SLOW"
  integrate_signalled "$SIG"
  assert_exit_code "$WANT" "$RC" "integrate.sh exit"
  assert_eq "1|$WANT|0|1" "$(q "SELECT COUNT(*) || '|' || MAX(exit_code) || '|' || MAX(timed_out) || '|' || MIN(finished_at IS NOT NULL) FROM verification_runs;")" "the run row is finished with the signal's exit code"
  assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
  assert_no_temp_worktree
  cleanup
done

test_case "no review: exit 3, nothing touched"
setup clean
q "DELETE FROM validation_attempts;"
integrate main
assert_exit_code 3 "$RC" "integrate.sh exit ($ERR)"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

test_case "a pass verdict for an earlier commit is no review of this one: exit 3"
setup clean
q "UPDATE audit SET content_json = '{\"task_id\":1,\"commit_sha\":\"$BASE0\"}';"
integrate main
assert_exit_code 3 "$RC" "integrate.sh exit ($ERR)"
cleanup

test_case "base not moved: prints the original SHA, records nothing"
setup none
integrate main
assert_exit_code 0 "$RC" "integrate.sh exit ($ERR)"
assert_eq "$COMMIT" "$OUT" "printed SHA"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

test_case "branch checked out in a worktree: exit 4 before any rebase"
setup clean
g worktree add -q "$REPO/.claude/worktrees/x-1" feat/x-1
integrate main
assert_exit_code 4 "$RC" "integrate.sh exit ($ERR)"
assert_contains "$ERR" "checked out at" "stderr names the holder"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
cleanup

test_case "re-integration after main moves again: the branch moves from the verified rebase"
setup clean
integrate main
FIRST="$OUT"
commit_file n.txt again
integrate main
assert_exit_code 0 "$RC" "integrate.sh exit ($ERR)"
assert_eq "$OUT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
if [ "$OUT" != "$FIRST" ]; then _pass; else _fail "second integration printed the first SHA"; fi
assert_eq "$(g rev-parse main)" "$(g rev-parse "$OUT^")" "the second rebase sits on main"
cleanup

# setup_node_modules <main-move> <verification json> — setup, then main tracks
# package.json, pkg/package.json and other/package.json; the main checkout holds
# untracked node_modules/marker and pkg/node_modules/marker, other/ has none.
setup_node_modules() {
  setup "$1" "$2"
  mkdir -p "$REPO/pkg" "$REPO/other"
  printf '{}\n' > "$REPO/package.json"
  printf '{}\n' > "$REPO/pkg/package.json"
  printf '{}\n' > "$REPO/other/package.json"
  g add package.json pkg/package.json other/package.json
  g commit -qm "chore: package manifests"
  mkdir -p "$REPO/node_modules" "$REPO/pkg/node_modules"
  printf 'root-dep\n' > "$REPO/node_modules/marker"
  printf 'pkg-dep\n' > "$REPO/pkg/node_modules/marker"
}

assert_markers_intact() {
  assert_eq "root-dep" "$(cat "$REPO/node_modules/marker" 2>/dev/null)" "main checkout node_modules/marker"
  assert_eq "pkg-dep" "$(cat "$REPO/pkg/node_modules/marker" 2>/dev/null)" "main checkout pkg/node_modules/marker"
}

NODE_MODULES_PASSING='["test -f node_modules/marker", "test -f pkg/node_modules/marker", "test ! -e other/node_modules"]'
NODE_MODULES_FAILING='["test -f node_modules/marker", "test -f pkg/node_modules/marker", "exit 5"]'

test_case "node_modules: untracked installs are linked into the worktree, clean rebase exits 0"
setup_node_modules clean "$NODE_MODULES_PASSING"
integrate main
assert_exit_code 0 "$RC" "integrate.sh exit ($ERR)"
assert_eq "$OUT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "3" "$(q "SELECT COUNT(*) FROM verification_run_commands WHERE exit_code = 0;")" "all three commands passed"
assert_no_temp_worktree
assert_markers_intact
cleanup

test_case "node_modules: failing verification exits 1 and leaves the main checkout's installs"
setup_node_modules clean "$NODE_MODULES_FAILING"
integrate main
assert_exit_code 1 "$RC" "integrate.sh exit ($ERR)"
assert_eq "0|0|5" "$(q "SELECT group_concat(exit_code, '|') FROM (SELECT exit_code FROM verification_run_commands ORDER BY ordinal);")" "the links resolved before the failing command"
assert_no_temp_worktree
assert_markers_intact
cleanup

test_case "node_modules: conflict exits 2 and leaves the main checkout's installs"
setup_node_modules conflict "$NODE_MODULES_PASSING"
integrate main
assert_exit_code 2 "$RC" "integrate.sh exit ($ERR)"
assert_no_temp_worktree
assert_markers_intact
cleanup

# Generated files (GH 1652). .gitattributes routes gen/** to the tmb-regen
# merge driver (keeps ours); scripts/maintenance/regen-generated.sh rebuilds
# gen/out.txt from src/*.txt. src/s.txt holds l1..l7; the task changes l4 and
# regenerates, then main moves with its own src/ change and regenerates, so
# gen/out.txt conflicts on every rebase:
#   gen      — src/base.txt (gen/out.txt is the only conflict)
#   drift    — l2 of src/s.txt (merges cleanly, but the task's source patch
#              context changes)
#   conflict — l4 of src/s.txt (a real source conflict)
#   absorbed — the task's own l4 change (the rebase drops the task commit)
# The regen mode "fail" commits a regen script that exits 2.
REGEN_OK='#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/../.."
cat src/*.txt > gen/out.txt'
REGEN_FAIL='#!/usr/bin/env bash
echo "regen-generated: toolchain missing" >&2
exit 2'
REGEN_PASSING='["grep -q l4-task src/s.txt", "bash scripts/maintenance/regen-generated.sh && git diff --exit-code -- gen"]'

regen_commit() {
  local msg="$1"
  mkdir -p "$REPO/gen"
  cat "$REPO"/src/*.txt > "$REPO/gen/out.txt"
  g add -A src gen
  g commit -qm "$msg"
}

s_lines() {
  local line="$1" value="$2" i
  for i in 1 2 3 4 5 6 7; do
    if [ "$i" = "$line" ]; then printf '%s\n' "$value"; else printf 'l%s\n' "$i"; fi
  done > "$REPO/src/s.txt"
}

# setup_regen <main-move> [<regen: ok|fail>]
setup_regen() {
  local move="$1" regen="${2:-ok}"
  setup none "$REGEN_PASSING"
  bash "$PLUGIN_ROOT/scripts/maintenance/install-merge-driver.sh" "$REPO" >/dev/null
  g checkout -q main
  g branch -q -D feat/x-1
  printf 'gen/** merge=tmb-regen\n' > "$REPO/.gitattributes"
  mkdir -p "$REPO/scripts/maintenance" "$REPO/src"
  if [ "$regen" = fail ]; then
    printf '%s\n' "$REGEN_FAIL" > "$REPO/scripts/maintenance/regen-generated.sh"
  else
    printf '%s\n' "$REGEN_OK" > "$REPO/scripts/maintenance/regen-generated.sh"
  fi
  s_lines 0 ''
  g add .gitattributes scripts
  regen_commit "chore: generated gen/out.txt"
  g checkout -q -b feat/x-1
  s_lines 4 l4-task
  regen_commit "feat: l4"
  COMMIT=$(g rev-parse HEAD)
  g checkout -q main
  case "$move" in
    gen) printf 'base\n' > "$REPO/src/base.txt" ;;
    drift) s_lines 2 l2-base ;;
    conflict) s_lines 4 l4-base ;;
    absorbed) s_lines 4 l4-task ;;
  esac
  regen_commit "feat: main moves ($move)"
  q "UPDATE tasks SET commit_sha = '$COMMIT';
     UPDATE audit SET content_json = '{\"task_id\":1,\"commit_sha\":\"$COMMIT\"}';"
}

# fresh_regen_matches <sha> — gen/ at <sha> equals a regen of <sha>'s src/.
fresh_regen_matches() {
  local check="$REPO/.claude/regen-check" rc=0
  g worktree add -q --detach "$check" "$1"
  (cd "$check" && bash scripts/maintenance/regen-generated.sh && git diff --quiet -- gen) || rc=$?
  g worktree remove --force "$check"
  return "$rc"
}

test_case "generated-file conflict only: regenerated, amended, verified, exit 0"
setup_regen gen
integrate main
assert_exit_code 0 "$RC" "integrate.sh exit ($ERR)"
NEW="$OUT"
assert_eq "$NEW" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "$(g rev-parse main)" "$(g rev-parse "$NEW^" 2>/dev/null)" "the rebased commit's parent is main"
assert_eq "feat: l4|Test" "$(g log -1 --format='%s|%an' "$NEW" 2>/dev/null)" "the amended commit keeps the task's message and author"
assert_eq "$(printf 'base\nl1\nl2\nl3\nl4-task\nl5\nl6\nl7')" "$(g show "$NEW:gen/out.txt" 2>/dev/null)" "gen/out.txt holds both sides' sources"
assert_no_temp_worktree
if [ "$RC" -eq 0 ] && fresh_regen_matches "$NEW"; then _pass; else _fail "gen/out.txt at $NEW differs from a fresh regen"; fi
assert_eq "1|manual|0" "$(q "SELECT COUNT(*) || '|' || MAX(source) || '|' || MAX(exit_code) FROM verification_runs WHERE commit_sha = '$NEW';")" "a passing manual run on the printed SHA"
cleanup

test_case "generated-file conflict with source drift: exit 2, nothing recorded"
setup_regen drift
integrate main
assert_exit_code 2 "$RC" "integrate.sh exit ($ERR)"
assert_contains "$ERR" "patch" "stderr names the patch-id mismatch"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

test_case "source conflict beside a generated-file conflict: exit 2"
setup_regen conflict
integrate main
assert_exit_code 2 "$RC" "integrate.sh exit ($ERR)"
assert_contains "$ERR" "conflicted" "stderr names the conflict"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

test_case "task change already on main: exit 2, main's commit is not amended"
setup_regen absorbed
MAIN_TIP=$(g rev-parse main)
integrate main
assert_exit_code 2 "$RC" "integrate.sh exit ($ERR)"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "$MAIN_TIP" "$(g rev-parse main)" "main tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

test_case "failing regen: exit 2 naming regen-generated.sh, branch unmoved"
setup_regen gen fail
integrate main
assert_exit_code 2 "$RC" "integrate.sh exit ($ERR)"
assert_eq "" "$OUT" "nothing on stdout"
assert_contains "$ERR" "regen-generated.sh exited 2" "stderr names the failing regen script"
assert_contains "$ERR" "toolchain missing" "stderr carries the regen output"
assert_eq "$COMMIT" "$(g rev-parse refs/heads/feat/x-1)" "feat/x-1 tip"
assert_eq "0" "$(q "SELECT COUNT(*) FROM verification_runs;")" "verification_runs rows"
assert_no_temp_worktree
cleanup

# git-guards denies a rebase in the main checkout; the temporary worktree
# integrate.sh rebases in is a linked worktree, where rebase is allowed, and
# bro's own command is a script call git-guards does not judge as a rebase.
run_guards() {
  local payload
  payload=$(jq -cn --arg c "$1" --arg d "$REPO" '{cwd:$d,tool_input:{command:$c}}')
  (cd "$REPO" && printf '%s' "$payload" | TRAJECTORY_DB_PATH="$DB" bash "$GUARDS" 2>&1 || true)
}

test_case "git-guards: rebase in the temp worktree allowed, in the main checkout denied"
setup clean
WT="$REPO/.claude/worktrees/integrate-1.abc123"
g worktree add -q --detach "$WT" "$COMMIT"
out=$(run_guards "cd $WT && git rebase main")
assert_not_contains "$out" '"permissionDecision":"deny"' "a rebase in the temporary worktree"
out=$(run_guards "git -C $REPO rebase main")
assert_contains "$out" '"permissionDecision":"deny"' "a rebase in the main checkout"
assert_contains "$out" "main checkout" "the deny names the main checkout"
out=$(run_guards "bash $SCRIPT 1 main")
assert_not_contains "$out" '"permissionDecision":"deny"' "bro running integrate.sh from the main checkout"
cleanup

summarize
