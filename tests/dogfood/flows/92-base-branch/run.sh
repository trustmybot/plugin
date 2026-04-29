#!/usr/bin/env bash
# L5 v2 — 92-base-branch (issue #101 / #92 follow-up)
# Verifies bro respects plugin_config.pr_target when proposing parent branch.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="92-base-branch"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro write a python cli todo"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
UPDATE plugin_config SET value_json = '"dev"' WHERE key = 'pr_target';
SQL

(
  cd "$PROJECT"
  git checkout -q -b dev
  git checkout -q main
) >/dev/null

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
