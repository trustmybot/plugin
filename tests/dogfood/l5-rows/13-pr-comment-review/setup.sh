#!/usr/bin/env bash
# Pre-seed a closed task on feat/todo-add so the /monitor flow has prior work
# context. The pr_comments_get call will still fail in the L5 sandbox (no real
# upstream PR), but bro should attempt it and respond gracefully.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

(
  cd "$PROJECT" || exit 1
  git checkout -q -b feat/todo-add
  git checkout -q main
) >/dev/null

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (13, 'Add TODO add command', 'Pre-seeded — upstream MR opened on this work.',
        'closed', datetime('now'), datetime('now'));

INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, status, commit_sha,
                   created_at, updated_at)
VALUES (13, 13, 'feat/todo-add', 'main', 'Add TODO add command',
        'See spec.', 'See spec.', 'closed',
        'abcdef1234567890abcdef1234567890abcdef12',
        datetime('now'), datetime('now'));

-- Pre-seed an incremental-polling cursor as if a prior /monitor 123 run had
-- happened. The current /monitor turn can't reach a real upstream PR so it
-- won't advance the cursor, but the outcome scorer should still find this
-- row intact — proves the cursor table is persisted across sessions.
INSERT INTO pr_review_runs (pr_number, repo, last_fetched_at, last_comment_id)
VALUES (123, 'org/todo-cli', '2026-05-12T10:00:00Z', 'rc-pre-seed');
SQL
