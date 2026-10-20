#!/usr/bin/env bash
# 05.06-base-branch L5 isolation: seeds repos.target_branch='dev' and creates the dev branch.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

REPO_NAME="$(basename "$PROJECT")"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT INTO repos (name, path, file_count, target_branch, branching_model, protected_branches)
VALUES ('$REPO_NAME', '$PROJECT', 0, 'dev', 'gitflow', '["main","dev"]')
ON CONFLICT(name) DO UPDATE SET
  path = excluded.path,
  target_branch = excluded.target_branch,
  branching_model = excluded.branching_model,
  protected_branches = excluded.protected_branches;
SQL

if git -C "$PROJECT" rev-parse -q --verify HEAD >/dev/null 2>&1; then
  (
    cd "$PROJECT" || exit 1
    git checkout -q -b dev
    git checkout -q main
  ) >/dev/null
fi
