#!/usr/bin/env bash
# Shared helpers for L5 flow scripts. Source this from tests/dogfood/flows/*.test.sh.

set -uo pipefail

# l6_setup_scratch_project: creates a fresh Docker-isolated scratch dir,
# initializes git, sets test identity. Returns the absolute path on stdout.
l6_setup_scratch_project() {
  local dir
  dir=$(mktemp -d -t tmb-l5-XXXX)
  (
    cd "$dir" || exit 1
    git init -q -b main
    git config user.email l6@l6.test
    git config user.name "L5 Test"
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
  local fixture_path="$L5_DOGFOOD_DIR/fixtures/${fixture}.sql"
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
# Echoes claude's stdout + stderr to OUR stderr so CI logs capture them
# (otherwise diagnosis is impossible — see issue #116). Always returns 0
# so the test can score the trajectory regardless of claude's exit code.
#
# `--dangerously-skip-permissions` is required: in headless `-p` mode
# claude blocks every tool call (Bash, Edit, MCP) until a human approves
# them, and there is no human in the loop here. The scratch dir is a
# fresh mktemp-d, so there's nothing to harm.
l6_run_claude() {
  local dir="$1" prompt="$2"
  (
    cd "$dir" || exit 1
    export TMB_DEBUG_TRAJECTORY=1
    export CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN}"
    echo "  ── claude invocation start ──" >&2
    echo "  cwd: $dir" >&2
    echo "  plugin-dir: $PLUGIN_ROOT" >&2
    echo "  prompt: $prompt" >&2
    timeout 180 claude --plugin-dir "$PLUGIN_ROOT" --dangerously-skip-permissions -p "$prompt" 2>&1 \
      | sed 's/^/  [claude] /' >&2 || true
    echo "  ── claude invocation end (exit was masked) ──" >&2
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
# When L5_KEEP_ARTIFACTS=1, becomes a no-op so the workflow's
# upload-artifact step can collect the trajectory DB after a failure.
l6_cleanup_project() {
  local dir="$1"
  [ "${L5_KEEP_ARTIFACTS:-0}" = "1" ] && return 0
  [ -n "$dir" ] && [ -d "$dir" ] && rm -rf "$dir"
}

# Initialize globals used by helpers.
L5_DOGFOOD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export L5_DOGFOOD_DIR

# Source v2 scorers (issue #110).
# shellcheck source=tests/dogfood/lib/scorers.sh
. "$L5_DOGFOOD_DIR/lib/scorers.sh"
