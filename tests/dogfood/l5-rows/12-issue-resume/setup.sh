#!/usr/bin/env bash
# Pre-seed an in-progress issue + planned-but-not-started task. Substrate
# for the resume-across-turns scenario.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

(
  cd "$PROJECT" || exit 1
  git checkout -q -b feat/seed-cli
  git checkout -q main
) >/dev/null

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
-- Use AUTOINCREMENT (omit explicit id) so this scenario works both as an
-- L5 unit (clean DB) and as an L6 chain step where IDs are already taken
-- by prior rows. Substantive assertions key off branch_id, not numeric id.
INSERT INTO issues (objective, description, status, created_at, updated_at)
VALUES ('Add a CLI entry point (resume)', 'Pre-seeded for the resume scenario.',
        'open', datetime('now'), datetime('now'));

INSERT INTO tasks (issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, success_criteria, status,
                   created_at, updated_at)
SELECT id, 'feat/seed-cli', 'main', 'Add CLI entry point',
       '## Description
Add a CLI entry script at cli.py that calls into the existing add() function.

## Files
- cli.py — new

## Success Criteria
- python cli.py 2 3 prints 5
- ruff + black pass

## Verification
- python cli.py 2 3
', 'See spec.', 'See success criteria.', 'pending',
       datetime('now'), datetime('now')
FROM issues
WHERE objective = 'Add a CLI entry point (resume)'
ORDER BY id DESC LIMIT 1;

INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary,
                   content_json, created_at)
SELECT id, 'feat/seed-cli', 'bro', 'event', 'planning_complete',
       'Pre-seeded planning_complete for resume scenario.',
       '{}', datetime('now')
FROM issues
WHERE objective = 'Add a CLI entry point (resume)'
ORDER BY id DESC LIMIT 1;
SQL
