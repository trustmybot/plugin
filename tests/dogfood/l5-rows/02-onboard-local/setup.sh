#!/usr/bin/env bash
# Local-shape onboarding seed. onboarding-named.sql already seeds identity +
# deep_scan_completed audit; this script ensures plugin_config defaults are
# explicit (idempotent INSERTs that the schema may or may not auto-apply).
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT OR REPLACE INTO plugin_config (key, value, updated_at)
VALUES
  ('branching_model', '"github-flow"', datetime('now')),
  ('pr_target',       '"main"',        datetime('now')),
  ('protected_branches', '["main"]',   datetime('now')),
  ('remotes',         '[]',            datetime('now')),
  ('issue_sync',      '"off"',         datetime('now'));
SQL
