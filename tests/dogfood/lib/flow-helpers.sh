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

# l6_assert_trajectory <project_dir> <expected_file>: reads the recorded
# trajectory and verifies every line in <expected_file> appears as a
# substring in the actual sequence (in order). Returns 0 if all matched.
#
# Expected file format (one line per expected step):
#   mcp_call:mcp__plugin_tmb_trajectory-server__identity_get
#   mcp_call:mcp__plugin_tmb_trajectory-server__config_get
#   tool_use:Bash
#   ...
#
# Allows extra steps to appear between expected lines (subset match in order).
l6_assert_trajectory() {
  local dir="$1" expected_file="$2"
  if [ ! -f "$expected_file" ]; then
    printf "  ✗ expected file missing: %s\n" "$expected_file" >&2
    return 1
  fi
  local actual
  actual=$(sqlite3 "$dir/.claude/tmb/trajectory.db" \
    "SELECT kind || ':' || tool_or_mcp_name FROM debug_trajectory ORDER BY id")

  if [ -z "$actual" ]; then
    printf "  ✗ no trajectory rows recorded — TMB_DEBUG_TRAJECTORY may not be wired\n" >&2
    return 1
  fi

  # Walk both lists; expected must be a subset-in-order of actual.
  local idx=0
  local found=0
  local expected_lines=()
  while IFS= read -r line; do
    [ -n "$line" ] && expected_lines+=("$line")
  done < "$expected_file"

  while IFS= read -r actual_line; do
    if [ "$idx" -ge "${#expected_lines[@]}" ]; then
      break
    fi
    if [[ "$actual_line" == *"${expected_lines[$idx]}"* ]]; then
      idx=$((idx + 1))
      found=$((found + 1))
    fi
  done <<< "$actual"

  if [ "$idx" -eq "${#expected_lines[@]}" ]; then
    printf "  ✓ matched %d/%d expected steps\n" "$found" "${#expected_lines[@]}"
    return 0
  else
    printf "  ✗ matched %d/%d expected steps; missing: %s\n" \
      "$found" "${#expected_lines[@]}" "${expected_lines[$idx]}" >&2
    printf "  --- actual trajectory (first 30) ---\n" >&2
    echo "$actual" | head -30 >&2
    return 1
  fi
}

# l6_cleanup_project <project_dir>: removes the scratch directory.
l6_cleanup_project() {
  local dir="$1"
  [ -n "$dir" ] && [ -d "$dir" ] && rm -rf "$dir"
}

# Initialize globals used by helpers.
L6_DOGFOOD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export L6_DOGFOOD_DIR
