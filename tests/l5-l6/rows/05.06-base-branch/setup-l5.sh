#!/usr/bin/env bash
# 05.06-base-branch L5 isolation: sets pr_target='dev' and creates the dev branch.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
UPDATE plugin_config SET value_json = '"dev"' WHERE key = 'pr_target';
SQL

(
  cd "$PROJECT" || exit 1
  git checkout -q -b dev
  git checkout -q main
) >/dev/null