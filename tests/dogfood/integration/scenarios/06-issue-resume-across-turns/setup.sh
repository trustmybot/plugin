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
INSERT INTO issues (id, objective, description, status, created_at, updated_at)
VALUES (1, 'Add a CLI entry point', 'Pre-seeded for the resume scenario.',
        'open', datetime('now'), datetime('now'));

INSERT INTO tasks (id, issue_id, branch_id, parent_branch_id, title, spec_body,
                   description, success_criteria, status,
                   created_at, updated_at)
VALUES (1, 1, 'feat/seed-cli', 'main', 'Add CLI entry point',
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
        datetime('now'), datetime('now'));

INSERT INTO audit (issue_id, branch_id, from_node, kind, event_type, summary,
                   content_json, created_at)
VALUES (1, 'feat/seed-cli', 'bro', 'event', 'planning_complete',
        'Pre-seeded planning_complete for resume scenario.',
        '{}', datetime('now'));
SQL
