#!/usr/bin/env bash
# L5 multi-scorer test runner — canonical rows/ tree.
#
# Each row in tests/l5-l6/rows/ is an isolated L5 eval: fixture.txt seeds
# the DB, setup-l5.sh (if present) pre-seeds env state, claude runs with
# script.json config, all scorers present in the row dir are evaluated.
#
# Usage:
#   bash tests/l5-l6/run-l5.sh             # all rows
#   bash tests/l5-l6/run-l5.sh 07          # filter by substring match on row name
#
# Requirements:
#   - CLAUDE_CODE_OAUTH_TOKEN env var (or active CC session in macOS keychain)
#   - claude in PATH
#   - sqlite3, jq

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
FILTER="${1:-}"
export PLUGIN_ROOT

if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf "❌ CLAUDE_CODE_OAUTH_TOKEN not set.\n"
  printf "   For local runs: export CLAUDE_CODE_OAUTH_TOKEN=...\n"
  printf "   For CI: configure as a repo secret (Settings → Secrets).\n"
  exit 1
fi

for cmd in claude sqlite3 jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf "❌ %s not found in PATH.\n" "$cmd"
    exit 1
  fi
done

. "$HERE/lib/smoke-helpers.sh"
l5_pre_flight_or_abort "$PLUGIN_ROOT"

# shellcheck source=tests/l5-l6/lib/l6-chain-helpers.sh
. "$HERE/lib/l6-chain-helpers.sh"

# shellcheck source=tests/l5-l6/lib/sandbox.sh
. "$HERE/lib/sandbox.sh"

printf "=== claude --version (informational) ===\n"
claude --version 2>&1 | sed 's/^/  /' || echo "  ✗ claude --version failed"
printf "\n"

PASS=0
FAIL=0
FAILED_ROWS=()
RUN_BASE="$(date +%s)-$$"

# Discover LEAF row dirs across the family-folder layout. A row dir is a leaf
# that contains a row marker (prompt.txt / fixture.txt); family container dirs
# (rows/NN/ holding only subdirs) are skipped. Rows live one or two levels deep:
#   rows/23-bulk-cleanup/            (flat, standalone)
#   rows/NN/NN-name/, rows/NN/NN.MM-name/  (family folders)
for row_dir in "$HERE/rows"/*/ "$HERE/rows"/*/*/; do
  [ -d "$row_dir" ] || continue
  # Skip family container dirs — only leaves carry a prompt/fixture marker.
  [ -f "$row_dir/prompt.txt" ] || [ -f "$row_dir/fixture.txt" ] || continue
  row_name=$(basename "$row_dir")

  if [ -n "$FILTER" ] && [[ "$row_name" != *"$FILTER"* ]]; then
    continue
  fi

  [ -f "$row_dir/prompt.txt" ] || continue

  printf "\n=== L5 row: %s ===\n" "$row_name"

  FLOW_NAME="$row_name"
  RUN_ID="${RUN_BASE}-${row_name}"
  export FLOW_NAME RUN_ID

  PROJECT=$(l5_setup_scratch_project)
  trap 'l5_cleanup_project "$PROJECT"' EXIT

  fixture_name="onboarding-named"
  if [ -f "$row_dir/fixture.txt" ]; then
    fixture_name=$(cat "$row_dir/fixture.txt")
  fi

  if ! l5_seed_db "$PROJECT" "$fixture_name"; then
    printf "  ✗ %s: fixture seed failed\n" "$row_name"
    FAIL=$((FAIL + 1))
    FAILED_ROWS+=("$row_name")
    trap - EXIT
    l5_cleanup_project "$PROJECT"
    continue
  fi

  if [ -f "$row_dir/setup-l5.sh" ]; then
    if ! bash "$row_dir/setup-l5.sh" "$PROJECT" "$row_dir"; then
      printf "  ✗ %s: setup-l5.sh failed\n" "$row_name"
      FAIL=$((FAIL + 1))
      FAILED_ROWS+=("$row_name")
      trap - EXIT
      l5_cleanup_project "$PROJECT"
      continue
    fi
  fi

  TURN_JSONL="$PROJECT/trajectory.jsonl"
  _l5_write_pre_run_git_snapshot "$PROJECT"
  tmb_test_sandbox_init "$PROJECT"
  l6c_run_step "$PROJECT" "$row_dir" "$TURN_JSONL"
  tmb_test_sandbox_teardown

  if l5_score_flow "$PROJECT" "$row_name" "$row_dir" "$RUN_ID"; then
    printf "  ✓ %s passed\n" "$row_name"
    PASS=$((PASS + 1))
  else
    printf "  ✗ %s failed\n" "$row_name"
    FAIL=$((FAIL + 1))
    FAILED_ROWS+=("$row_name")
  fi

  trap - EXIT
  l5_cleanup_project "$PROJECT"
done

printf "\n========================================\n"
printf "L5: %d passed, %d failed\n" "$PASS" "$FAIL"

if [ "$FAIL" -gt 0 ]; then
  printf "Failed rows: %s\n" "${FAILED_ROWS[*]}"
  exit 1
fi
