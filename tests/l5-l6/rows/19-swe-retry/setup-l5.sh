#!/usr/bin/env bash
# Seeds a failed task + failure discussion. Triggers task_retry_batch composite
# + tmb_planning §Step 5 retry.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (1, 'Seed todo CLI', 'pre-seed for swe-retry flow', 'open',
        datetime('now'), datetime('now'));
INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, description,
                   status, created_at, updated_at)
VALUES (1, 1, 'feat/seed-todo', 'main', 'Seed todo CLI',
        'Implement todo.py CLI', 'failed',
        datetime('now'), datetime('now'));
INSERT INTO discussions (issue_id, author, kind, body, created_at)
VALUES (1, 'bro', 'concern',
        'verification failed: tests crashed on import — module path is wrong',
        datetime('now'));
SQL
