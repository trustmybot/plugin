#!/usr/bin/env bash
# Tests for scripts/hooks/worktree-create.sh.
# Hook contract: WorktreeCreate event. stdout = bare absolute worktree path on
# success; exit 0 = success, non-zero = fail. No JSON dialect. Informational
# output is stderr-only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/worktree-create.sh"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# --- fixture workspace -------------------------------------------------------
# Layout:
#   WORKSPACE/
#     .claude/tmb/trajectory.db   (DB with tasks)
#     inner/                      (the "inner" git repo tasks point at)

WORKSPACE="$TMPDIR/workspace"
INNER_REPO="$WORKSPACE/inner"

mkdir -p "$INNER_REPO"

git init -q -b main "$INNER_REPO"
cd "$INNER_REPO"
git config user.email t@t.io && git config user.name t
echo init > README.md && git add . && git commit -qm init

DB="$WORKSPACE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$DB")"
INNER_ROOT=$(git -C "$INNER_REPO" rev-parse --show-toplevel)
sqlite3 "$DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    branch_id TEXT NOT NULL,
    status TEXT,
    repo TEXT
  );
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE repos (
    name TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    protected_branches TEXT
  );
  INSERT INTO repos (name, path) VALUES ('inner', '$INNER_ROOT');
  INSERT INTO tasks (id, branch_id, status, repo)
    VALUES (1, 'fix/123-with-repo', 'pending', 'inner');
  INSERT INTO tasks (id, branch_id, status, repo)
    VALUES (2, 'feat/456-no-repo', 'pending', NULL);
"
export TRAJECTORY_DB_PATH="$DB"

git -C "$INNER_REPO" branch fix/123-with-repo HEAD

input_event() {
  local branch="$1"
  jq -n --arg branch "$branch" '{branch: $branch}'
}

# run_hook_stdout: stdout only, stderr suppressed; returns exit code via $?
run_hook_stdout() {
  echo "$1" | bash "$HOOK" 2>/dev/null || return $?
}

# run_hook_stderr: stderr only, stdout suppressed; always exits 0 for capture
run_hook_stderr() {
  echo "$1" | { bash "$HOOK" >/dev/null; } 2>&1 || true
}

# --- tests -------------------------------------------------------------------

test_case "no branch in input: exits non-zero, empty stdout"
no_branch_stdout=$(echo '{}' | bash "$HOOK" 2>/dev/null || true)
assert_eq "" "$no_branch_stdout" "no branch → empty stdout"
no_branch_exit=0
echo '{}' | bash "$HOOK" 2>/dev/null || no_branch_exit=$?
if [ "$no_branch_exit" -ne 0 ]; then _pass; else _fail "expected non-zero exit for no-branch input"; fi

test_case "informational output is stderr-only on success path"
git -C "$INNER_REPO" branch feat/999-for-stderr-test HEAD 2>/dev/null || true
sqlite3 "$DB" "INSERT OR IGNORE INTO tasks (id, branch_id, status, repo) VALUES (99, 'feat/999-for-stderr-test', 'pending', 'inner');"
stdout_only=$(echo "$(input_event 'feat/999-for-stderr-test')" | bash "$HOOK" 2>/dev/null)
case "$stdout_only" in
  /*)  _pass ;;
  *)   _fail "stdout is not an absolute path: '$stdout_only'" ;;
esac
assert_not_contains "$stdout_only" '"continue"' "stdout must not contain JSON"
assert_not_contains "$stdout_only" 'tmb worktree-create' "informational text must be on stderr"

# A second registered repo so the single-repo fallback is NOT silently in play
# for the no-match / NULL-repo cases — they must resolve to the workspace root
# (which is not a git repo) and fail loudly, proving no name-keyed default is used.
SIBLING_REPO="$WORKSPACE/sibling"
mkdir -p "$SIBLING_REPO"
git init -q -b main "$SIBLING_REPO"
git -C "$SIBLING_REPO" config user.email t@t.io && git -C "$SIBLING_REPO" config user.name t
echo init > "$SIBLING_REPO/README.md"
git -C "$SIBLING_REPO" add . && git -C "$SIBLING_REPO" commit -qm init
SIBLING_ROOT=$(git -C "$SIBLING_REPO" rev-parse --show-toplevel)

test_case "no-match + multi-repo (no single-repo fallback) + workspace not git: exit non-zero with stderr reason"
# feat/888-unknown not in tasks; two repos registered → no single-repo fallback;
# workspace root is not a git repo → loud failure.
sqlite3 "$DB" "INSERT INTO repos (name, path) VALUES ('sibling', '$SIBLING_ROOT');"
no_match_exit=0
echo "$(input_event 'feat/888-unknown')" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null || no_match_exit=$?
if [ "$no_match_exit" -ne 0 ]; then _pass; else _fail "expected non-zero when workspace root is not a git repo"; fi
no_match_stderr=$(run_hook_stderr "$(input_event 'feat/888-unknown')")
assert_contains "$no_match_stderr" 'not a git work tree' "stderr explains why creation failed"
sqlite3 "$DB" "DELETE FROM repos WHERE name='sibling';"

test_case "no-match + single-repo fallback (one registered repo): worktree created, bare path on stdout"
git -C "$INNER_REPO" branch feat/777-nomatch HEAD 2>/dev/null || true
no_match_path=$(echo "$(input_event 'feat/777-nomatch')" | bash "$HOOK" 2>/dev/null)
case "$no_match_path" in
  /*)  _pass "stdout is absolute path" ;;
  *)   _fail "stdout is not an absolute path: '$no_match_path'" ;;
esac
assert_contains "$no_match_path" '777-nomatch' "path contains slug"
NOMATCH_WT="$WORKSPACE/.claude/worktrees/777-nomatch"
if [ -d "$NOMATCH_WT" ]; then _pass; else _fail "worktree not created at $NOMATCH_WT"; fi

test_case "no-match + single-repo fallback: branch auto-created when missing"
# feat/666-autocreate does not exist as a branch in inner repo
autocreate_path=$(echo "$(input_event 'feat/666-autocreate')" | bash "$HOOK" 2>/dev/null)
case "$autocreate_path" in
  /*)  _pass "stdout is absolute path" ;;
  *)   _fail "stdout is not an absolute path: '$autocreate_path'" ;;
esac
AUTOCREATE_WT="$WORKSPACE/.claude/worktrees/666-autocreate"
if [ -d "$AUTOCREATE_WT" ]; then _pass; else _fail "worktree not created at $AUTOCREATE_WT"; fi
if git -C "$INNER_REPO" show-ref --verify --quiet "refs/heads/feat/666-autocreate" 2>/dev/null; then
  _pass "branch auto-created in inner repo"
else
  _fail "branch feat/666-autocreate not auto-created"
fi

test_case "repo=NULL + multi-repo (no single-repo fallback) + workspace not git: exit 1 with clear error"
sqlite3 "$DB" "INSERT INTO repos (name, path) VALUES ('sibling', '$SIBLING_ROOT');"
null_repo_exit=0
echo "$(input_event 'feat/456-no-repo')" | TRAJECTORY_DB_PATH="$DB" bash "$HOOK" 2>/dev/null || null_repo_exit=$?
if [ "$null_repo_exit" -ne 0 ]; then _pass; else _fail "expected non-zero exit"; fi
null_repo_stderr=$(run_hook_stderr "$(input_event 'feat/456-no-repo')")
assert_contains "$null_repo_stderr" 'not a git work tree' "unroutable null repo → loud error"
sqlite3 "$DB" "DELETE FROM repos WHERE name='sibling';"

test_case "repo=NULL + single-repo fallback: worktree created in the sole repo, bare path on stdout"
git -C "$INNER_REPO" branch feat/456-no-repo HEAD 2>/dev/null || true
no_repo_path=$(echo "$(input_event 'feat/456-no-repo')" | bash "$HOOK" 2>/dev/null)
case "$no_repo_path" in
  /*)  _pass "stdout is absolute path" ;;
  *)   _fail "stdout is not an absolute path: '$no_repo_path'" ;;
esac
assert_contains "$no_repo_path" '456-no-repo' "path contains slug"
if [ -d "$WORKSPACE/.claude/worktrees/456-no-repo" ]; then _pass; else _fail "worktree not created"; fi

test_case "branch matching task with repo set: stdout is bare absolute path"
task_path=$(echo "$(input_event 'fix/123-with-repo')" | bash "$HOOK" 2>/dev/null)
case "$task_path" in
  /*)  _pass "stdout is absolute path" ;;
  *)   _fail "stdout is not an absolute path: '$task_path'" ;;
esac
assert_not_contains "$task_path" '"continue"' "stdout must not contain JSON"
assert_contains "$task_path" '123-with-repo' "path contains slug"

WORKTREE_PATH="$WORKSPACE/.claude/worktrees/123-with-repo"
if [ -d "$WORKTREE_PATH" ]; then
  _pass
else
  _fail "worktree directory not created at $WORKTREE_PATH"
fi

test_case "worktree path is workspace-rooted, not repo-rooted, when workspace != repo"
REPO_ROOTED_PATH="$INNER_REPO/.claude/worktrees/123-with-repo"
if [ -d "$REPO_ROOTED_PATH" ]; then
  _fail "worktree must NOT be created inside inner repo at $REPO_ROOTED_PATH"
else
  _pass
fi

test_case "worktree is a valid git worktree"
if git -C "$WORKTREE_PATH" rev-parse --git-dir >/dev/null 2>&1; then
  _pass
else
  _fail "worktree dir is not a valid git worktree"
fi

test_case "REGRESSION (#2879): worktree HEAD is on the named branch"
HEAD_BRANCH=$(git -C "$WORKTREE_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$HEAD_BRANCH" = "fix/123-with-repo" ]; then
  _pass
else
  _fail "expected worktree HEAD on fix/123-with-repo, got '$HEAD_BRANCH'"
fi

test_case "REGRESSION (#2879): SWE-style commit in the worktree advances the branch ref"
echo "swe-commit" > "$WORKTREE_PATH/swe-file.txt"
git -C "$WORKTREE_PATH" add swe-file.txt
git -C "$WORKTREE_PATH" -c user.email=swe@t.io -c user.name=swe commit -qm "swe: add file"
SWE_HEAD=$(git -C "$WORKTREE_PATH" rev-parse HEAD)
BRANCH_TIP=$(git -C "$INNER_REPO" rev-parse fix/123-with-repo)
if [ "$SWE_HEAD" = "$BRANCH_TIP" ]; then
  _pass
else
  _fail "expected fix/123-with-repo to point at worktree HEAD ($SWE_HEAD); got $BRANCH_TIP — branch ref must move with the worktree commit"
fi

# --- single-repo fixture (#306) ---------------------------------------------
SINGLE="$TMPDIR/single"
mkdir -p "$SINGLE"
git init -q -b main "$SINGLE"
git -C "$SINGLE" config user.email t@t.io && git -C "$SINGLE" config user.name t
echo init > "$SINGLE/README.md"
git -C "$SINGLE" add . && git -C "$SINGLE" commit -qm init
SDB="$SINGLE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$SDB")"
SINGLE_ROOT=$(git -C "$SINGLE" rev-parse --show-toplevel)
sqlite3 "$SDB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT, repo TEXT);
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, protected_branches TEXT);
  INSERT INTO repos (name, path) VALUES ('single', '$SINGLE_ROOT');
  INSERT INTO tasks (id, branch_id, status, repo) VALUES (1, 'fix/789-single', 'pending', NULL);
"
git -C "$SINGLE" branch fix/789-single HEAD

SINGLE_WT="$SINGLE/.claude/worktrees/789-single"

test_case "#306: single-repo (workspace root is the repo), repo=NULL: worktree created, bare path on stdout"
single_path=$(echo "$(input_event 'fix/789-single')" | TRAJECTORY_DB_PATH="$SDB" bash "$HOOK" 2>/dev/null)
case "$single_path" in
  /*)  _pass "stdout is absolute path" ;;
  *)   _fail "stdout is not an absolute path: '$single_path'" ;;
esac
assert_not_contains "$single_path" '"continue"' "stdout must not contain JSON"
assert_contains "$single_path" '789-single' "path contains slug"
if [ -d "$SINGLE_WT" ]; then _pass; else _fail "worktree not created at $SINGLE_WT"; fi

test_case "#306: single-repo worktree HEAD is on the named branch"
HB=$(git -C "$SINGLE_WT" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$HB" = "fix/789-single" ]; then _pass; else _fail "expected HEAD on fix/789-single, got '$HB'"; fi

test_case "#306: idempotent — second fire reuses the existing worktree, bare path on stdout"
single_path2=$(echo "$(input_event 'fix/789-single')" | TRAJECTORY_DB_PATH="$SDB" bash "$HOOK" 2>/dev/null)
case "$single_path2" in
  /*)  _pass "stdout is absolute path on second call" ;;
  *)   _fail "stdout is not an absolute path on second call: '$single_path2'" ;;
esac
assert_contains "$single_path2" '789-single' "reused path contains slug"
assert_not_contains "$single_path2" 'failed' "no error message in stdout"

# --- multi-repo: session dir is parent of repo (#330) -----------------------
MR_WORKSPACE="$TMPDIR/mrsession"
MR_REPO="$MR_WORKSPACE/plugin"
mkdir -p "$MR_REPO"
git init -q -b main "$MR_REPO"
git -C "$MR_REPO" config user.email t@t.io && git -C "$MR_REPO" config user.name t
echo init > "$MR_REPO/README.md"
git -C "$MR_REPO" add . && git -C "$MR_REPO" commit -qm init

MR_DB="$MR_WORKSPACE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$MR_DB")"
MR_REPO_ROOT=$(git -C "$MR_REPO" rev-parse --show-toplevel)
sqlite3 "$MR_DB" "
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    branch_id TEXT NOT NULL,
    status TEXT,
    repo TEXT
  );
  CREATE TABLE plugin_config (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE repos (name TEXT PRIMARY KEY, path TEXT NOT NULL, protected_branches TEXT);
  INSERT INTO repos (name, path) VALUES ('plugin', '$MR_REPO_ROOT');
  INSERT INTO tasks (id, branch_id, status, repo)
    VALUES (10, 'fix/330-subdir', 'pending', 'plugin');
"
git -C "$MR_REPO" branch fix/330-subdir HEAD

MR_WT="$MR_WORKSPACE/.claude/worktrees/330-subdir"

test_case "#330: multi-repo (session dir is parent of repo subdir): bare path on stdout"
mr_path=$(echo "$(input_event 'fix/330-subdir')" | TRAJECTORY_DB_PATH="$MR_DB" bash "$HOOK" 2>/dev/null)
case "$mr_path" in
  /*)  _pass "stdout is absolute path" ;;
  *)   _fail "stdout is not an absolute path: '$mr_path'" ;;
esac
assert_not_contains "$mr_path" '"continue"' "stdout must not contain JSON"
assert_contains "$mr_path" '330-subdir' "path contains slug"
if [ -d "$MR_WT" ]; then _pass; else _fail "worktree not created at $MR_WT"; fi

test_case "#330: subdir-repo worktree HEAD is on the named branch"
MR_HB=$(git -C "$MR_WT" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$MR_HB" = "fix/330-subdir" ]; then _pass; else _fail "expected HEAD on fix/330-subdir, got '$MR_HB'"; fi

test_case "#330: worktree is workspace-rooted (not inside inner repo)"
MR_INNER_WT="$MR_REPO/.claude/worktrees/330-subdir"
if [ -d "$MR_INNER_WT" ]; then
  _fail "worktree must NOT be created inside inner repo at $MR_INNER_WT"
else
  _pass
fi

test_case "#330: SWE commit in multi-repo worktree advances inner repo branch ref"
echo "swe-330" > "$MR_WT/swe-330.txt"
git -C "$MR_WT" add swe-330.txt
git -C "$MR_WT" -c user.email=swe@t.io -c user.name=swe commit -qm "swe: 330 fix"
MR_SWE_HEAD=$(git -C "$MR_WT" rev-parse HEAD)
MR_BRANCH_TIP=$(git -C "$MR_REPO" rev-parse fix/330-subdir)
if [ "$MR_SWE_HEAD" = "$MR_BRANCH_TIP" ]; then
  _pass
else
  _fail "expected fix/330-subdir to point at worktree HEAD ($MR_SWE_HEAD); got $MR_BRANCH_TIP"
fi

summarize
