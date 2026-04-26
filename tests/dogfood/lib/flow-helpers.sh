#!/usr/bin/env bash
# Shared helpers for L6 flow scripts. Source this from tests/dogfood/flows/*.test.sh.

set -uo pipefail

# l6_setup_scratch_project: creates a fresh Docker-isolated scratch dir,
# initializes git, sets test identity. Returns the absolute path on stdout.
l6_setup_scratch_project() {
  local dir
  dir=$(mktemp -d -t tmb-l6-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email l6@l6.test
    git config user.name "L6 Test"
    echo "init" > README.md
    git add . && git commit -qm init
    mkdir -p .claude/tmb
  )
  echo "$dir"
}

# l6_seed_db <project_dir> <fixture_name>: applies a SQL fixture to the
# project's trajectory.db. Fixture must exist at tests/dogfood/fixtures/<name>.sql.
l6_seed_db() {
  local dir="$1" fixture="$2"
  local fixture_path="$L6_DOGFOOD_DIR/fixtures/${fixture}.sql"
  if [ ! -f "$fixture_path" ]; then
    printf "  ✗ fixture not found: %s\n" "$fixture_path" >&2
    return 1
  fi
  local schema_path="$PLUGIN_ROOT/mcp/trajectory-server/src/schema.sql"
  sqlite3 "$dir/.claude/tmb/trajectory.db" < "$schema_path"
  sqlite3 "$dir/.claude/tmb/trajectory.db" < "$fixture_path"
}

# l6_run_claude <project_dir> <prompt>: runs `claude -p` against the prompt
# in the project, with TMB_DEBUG_TRAJECTORY=1, plugin loaded via --plugin-dir.
# Returns exit code from claude.
l6_run_claude() {
  local dir="$1" prompt="$2"
  (
    cd "$dir" || exit 1
    export TMB_DEBUG_TRAJECTORY=1
    export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"
    timeout 180 claude --plugin-dir "$PLUGIN_ROOT" -p "$prompt" 2>&1 | tail -50 || true
  )
}

# l6_score_flow <project_dir> <flow_name> <scorer_dir> <run_id>: runs all
# v2 scorers against the project's trajectory DB. Returns 0 only if every
# scorer that's mandated for the flow passes. Issue #110.
#
# Scorers (per industry-standard Inspect AI / AgentEvals pattern):
#   1. outcome           — primary; SQL assertions on final DB state
#   2. trajectory_required — required tools were called (any order)
#   3. trajectory_forbidden — forbidden tools were NOT called
#   4. cost              — observational unless cost-budget says fail_above_max
l6_score_flow() {
  local project="$1" flow="$2" scorer_dir="$3" run_id="$4"
  local total_fail=0

  l6_score_outcome              "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l6_score_trajectory_required  "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l6_score_trajectory_forbidden "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))
  l6_score_cost                 "$project" "$flow" "$scorer_dir" "$run_id" || total_fail=$((total_fail + 1))

  return "$total_fail"
}

# l6_cleanup_project <project_dir>: removes the scratch directory.
l6_cleanup_project() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] && rm -rf "$dir"
}

# Initialize globals used by helpers.
L6_DOGFOOD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export L6_DOGFOOD_DIR

# Source v2 scorers (issue #110).
# shellcheck source=tests/dogfood/lib/scorers.sh
. "$L6_DOGFOOD_DIR/lib/scorers.sh"
