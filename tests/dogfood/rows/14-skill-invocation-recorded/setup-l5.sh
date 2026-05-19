#!/usr/bin/env bash
# Pre-seed an open bro agent_run row so the Skill PostToolUse hook
# (#2886) has something to FK to when it writes the skill_invocations
# row. In a full chain this row is opened by task_create_batch; in
# standalone L5 we pre-seed it directly.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT INTO agent_runs (task_id, issue_id, agent_type, started_at)
VALUES (NULL, NULL, 'bro', datetime('now'));
SQL
