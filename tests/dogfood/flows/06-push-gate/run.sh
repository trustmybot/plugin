#!/usr/bin/env bash
# L5 v2 — 06-push-gate (FLOWS.md §6)
# Seeds an unsigned task in needs_validation status with a real commit on a
# feature branch. Triggers bro to run tmb_push-gate → spawns pr-reviewer.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="06-push-gate"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro the task on feat/seed-todo is signed off — review and push it"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

(
  cd "$PROJECT"
  git checkout -q -b feat/seed-todo
  echo 'print("todo")' > todo.py
  git add todo.py
  git commit -qm 'feat: seed todo CLI (#1)'
  git checkout -q main
) >/dev/null

SEED_SHA=$(cd "$PROJECT" && git rev-parse feat/seed-todo)
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (1, 'Seed todo CLI', 'pre-seed for push-gate flow', 'open',
        datetime('now'), datetime('now'));
INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, objective, spec,
                   status, commit_sha, created_at, updated_at)
VALUES (1, 1, 'feat/seed-todo', 'main', 'Seed todo CLI',
        '## Files\ntodo.py\n', 'needs_validation', '$SEED_SHA',
        datetime('now'), datetime('now'));
SQL

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
