#!/usr/bin/env bash
# Pre-seed an unsigned task in needs_validation status with a real commit
# on a feature branch — the substrate the push gate operates against.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

(
  cd "$PROJECT" || exit 1
  git checkout -q -b feat/seed-todo
  echo 'print("todo")' > todo.py
  git add todo.py
  git commit -qm 'feat: seed todo CLI (#1)'
  git checkout -q main
) >/dev/null

SEED_SHA=$(git -C "$PROJECT" rev-parse feat/seed-todo)

# Use AUTOINCREMENT (omit explicit id) so this scenario works both as an
# L5 unit (clean DB) and as an L6 chain step where IDs are already taken
# by prior rows. Substantive assertions key off branch_id, not numeric id.
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<SQL
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Seed todo CLI (push-gate)', 'pre-seed for push-gate scenario', 'open',
        datetime('now'), datetime('now'));

INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, success_criteria, status, commit_sha,
                   created_at, updated_at)
SELECT id, 'feat/seed-todo', 'main', 'Seed todo CLI',
       '## Files
todo.py
', '', '', 'needs_validation', '$SEED_SHA',
       datetime('now'), datetime('now')
FROM issues
WHERE objective = 'Seed todo CLI (push-gate)'
ORDER BY id DESC LIMIT 1;
SQL
