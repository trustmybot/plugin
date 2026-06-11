#!/usr/bin/env bash
# Reonboard scenario starts from local-shape state. The post-AUQ remote-shape
# flip is the chain-bridge between this row and row 4 in L6 (handled by the
# chain manifest's between-row seed), not applied here in L5.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

# Make sure plugin_config has the local-shape baseline so onboard_state_get
# sees first_run=false (identity exists from the fixture).
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" <<'SQL'
INSERT OR REPLACE INTO plugin_config (key, value_json)
VALUES
  ('branching_model', '"github-flow"'),
  ('pr_target',       '"main"'),
  ('remotes',         '[]');
SQL
