#!/usr/bin/env bash
# L5 v2 — 08-swe-retry (FLOWS.md §8)
# Seeds a failed task + failure discussion. Triggers tmb_feedback-loop.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="08-swe-retry"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro that task on feat/seed-todo failed verification — review the feedback and retry with a corrected approach"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (1, 'Seed todo CLI', 'pre-seed for swe-retry flow', 'open',
        datetime('now'), datetime('now'));
INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, objective, spec,
                   status, created_at, updated_at)
VALUES (1, 1, 'feat/seed-todo', 'main', 'Seed todo CLI',
        '## Files\ntodo.py\n', 'failed',
        datetime('now'), datetime('now'));
INSERT INTO discussions (issue_id, branch_id, kind, body, created_at)
VALUES (1, 'feat/seed-todo', 'concern',
        'verification failed: tests crashed on import — module path is wrong',
        datetime('now'));
SQL

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
