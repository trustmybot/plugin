#!/usr/bin/env bash
# Tests for scripts/hooks/worktree-create.sh.
# Hook contract: WorktreeCreate event. It is the SOLE worktree-creation path
# (#306 — bro no longer pre-creates one manually). When task.repo is set,
# creates the worktree inside that repo; when repo is NULL/empty it falls back
# to the workspace root as the repo (single-repo CC). Returns {"continue":true}
# only when there's no matching task or the resolved repo isn't a git work tree.
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

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1
}

# --- tests -------------------------------------------------------------------

test_case "no branch in input: continue=true"
out=$(run_hook '{}')
assert_contains "$out" '"continue":true' "no branch → no-op"

test_case "branch with no matching task: continue=true"
out=$(run_hook "$(input_event 'feat/999-unknown')")
assert_contains "$out" '"continue":true' "unknown branch → no-op"

test_case "repo=NULL, no tmb_default_repo, workspace root is not a git repo: exit 1 with clear error"
# repo=NULL + no default + workspace root is not a git repo → fail loudly
# rather than silently continue into a harness "not a directory" error.
out=$(run_hook "$(input_event 'feat/456-no-repo')" || true)
assert_contains "$out" 'not a git work tree' "unroutable null repo → loud error"

test_case "repo=NULL, tmb_default_repo set, workspace root is not a git repo: worktree created in default repo"
# Inject tmb_default_repo = 'inner' into the DB so the hook can resolve the repo.
sqlite3 "$DB" "
  INSERT OR REPLACE INTO plugin_config (key, value_json)
    VALUES ('tmb_default_repo', '\"inner\"');
"
git -C "$INNER_REPO" branch feat/456-no-repo HEAD
out=$(run_hook "$(input_event 'feat/456-no-repo')")
assert_contains "$out" '"continue":false' "default_repo set → hook creates worktree"
assert_contains "$out" '456-no-repo' "worktree path contains slug"
DEFAULT_WT="$WORKSPACE/.claude/worktrees/456-no-repo"
if [ -d "$DEFAULT_WT" ]; then _pass; else _fail "worktree not created at $DEFAULT_WT"; fi
# Clean up so downstream tests are not affected
sqlite3 "$DB" "DELETE FROM plugin_config WHERE key='tmb_default_repo';"

test_case "branch matching task with repo set: worktree created at workspace-rooted path"
out=$(run_hook "$(input_event 'fix/123-with-repo')")
assert_not_contains "$out" '"continue":true' "repo set → not a no-op"
assert_contains "$out" '"continue":false' "repo set → continue=false"
assert_contains "$out" '123-with-repo' "worktree path contains slug"

WORKTREE_PATH="$WORKSPACE/.claude/worktrees/123-with-repo"
if [ -d "$WORKTREE_PATH" ]; then
  _pass
else
  _fail "worktree directory not created at $WORKTREE_PATH"
fi

test_case "worktree path is workspace-rooted, not repo-rooted, when workspace != repo"
# Workspace at $WORKSPACE, inner repo at $WORKSPACE/inner.
# tasks.repo='inner' → worktree must land at $WORKSPACE/.claude/worktrees/<slug>,
# NOT at $WORKSPACE/inner/.claude/worktrees/<slug>.
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
# The hook must produce a worktree where `git rev-parse --abbrev-ref HEAD`
# returns the branch name. Branch ownership lives in the worktree so SWE's
# commits advance the branch ref directly and pushes carry the work.
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
# Layout where the workspace root IS the git repo and the task has repo=NULL.
# This is the common single-repo case: the hook must still create the canonical
# .claude/worktrees/<slug> checkout (bro no longer does it manually).
SINGLE="$TMPDIR/single"
mkdir -p "$SINGLE"
git init -q -b main "$SINGLE"
git -C "$SINGLE" config user.email t@t.io && git -C "$SINGLE" config user.name t
echo init > "$SINGLE/README.md"
git -C "$SINGLE" add . && git -C "$SINGLE" commit -qm init
SDB="$SINGLE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$SDB")"
sqlite3 "$SDB" "
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, branch_id TEXT NOT NULL, status TEXT, repo TEXT);
  INSERT INTO tasks (id, branch_id, status, repo) VALUES (1, 'fix/789-single', 'pending', NULL);
"
git -C "$SINGLE" branch fix/789-single HEAD

run_hook_single() {
  echo "$1" | TRAJECTORY_DB_PATH="$SDB" bash "$HOOK" 2>&1
}
SINGLE_WT="$SINGLE/.claude/worktrees/789-single"

test_case "#306: single-repo (workspace root is the repo), repo=NULL: worktree created"
out=$(run_hook_single "$(input_event 'fix/789-single')")
assert_contains "$out" '"continue":false' "single-repo repo=NULL → hook creates worktree"
assert_contains "$out" '789-single' "worktree path contains slug"
if [ -d "$SINGLE_WT" ]; then _pass; else _fail "worktree not created at $SINGLE_WT"; fi

test_case "#306: single-repo worktree HEAD is on the named branch"
HB=$(git -C "$SINGLE_WT" rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$HB" = "fix/789-single" ]; then _pass; else _fail "expected HEAD on fix/789-single, got '$HB'"; fi

test_case "#306: idempotent — second fire reuses the existing worktree, no error"
out=$(run_hook_single "$(input_event 'fix/789-single')")
assert_contains "$out" '"continue":false' "second fire still returns a worktreePath"
assert_contains "$out" '789-single' "reused path contains slug"
assert_not_contains "$out" 'failed' "no git worktree-add failure on the second fire"

# --- multi-repo: session dir is parent of repo (#330) -----------------------
# Layout: WORKSPACE_MR/ (not a git repo — session launch dir)
#           .claude/tmb/trajectory.db
#           plugin/                   (the inner git repo tasks point at)
# tasks.repo = 'plugin' — the hook must git -C plugin/ worktree add
# and create the worktree at WORKSPACE_MR/.claude/worktrees/<slug>,
# NOT inside the inner repo.

MR_WORKSPACE="$TMPDIR/mrsession"
MR_REPO="$MR_WORKSPACE/plugin"
mkdir -p "$MR_REPO"
git init -q -b main "$MR_REPO"
git -C "$MR_REPO" config user.email t@t.io && git -C "$MR_REPO" config user.name t
echo init > "$MR_REPO/README.md"
git -C "$MR_REPO" add . && git -C "$MR_REPO" commit -qm init

MR_DB="$MR_WORKSPACE/.claude/tmb/trajectory.db"
mkdir -p "$(dirname "$MR_DB")"
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
  INSERT INTO tasks (id, branch_id, status, repo)
    VALUES (10, 'fix/330-subdir', 'pending', 'plugin');
"
git -C "$MR_REPO" branch fix/330-subdir HEAD

run_hook_mr() {
  echo "$1" | TRAJECTORY_DB_PATH="$MR_DB" bash "$HOOK" 2>&1
}
MR_WT="$MR_WORKSPACE/.claude/worktrees/330-subdir"

test_case "#330: multi-repo (session dir is parent of repo subdir): worktree created"
out=$(run_hook_mr "$(input_event 'fix/330-subdir')")
assert_contains "$out" '"continue":false' "subdir-repo → hook creates worktree"
assert_contains "$out" '330-subdir' "worktree path contains slug"
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
