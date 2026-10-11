#!/usr/bin/env bash
# Run every *.test.sh in tests/l3-integration/hooks/ and aggregate pass/fail.
# Each test file is wrapped with a 120s per-test timeout so a single stuck
# test reports FAIL and the runner continues.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Hooks resolve the trajectory DB from CLAUDE_PROJECT_DIR first; a value
# inherited from a Claude Code session would point tests at a live DB.
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR
. "$HERE/../../l5-l6/lib/timeout-shim.sh"

# Footprint: every test runs with HOME at one empty temp dir; after the suite it
# must still be empty — no hook writes project state (or anything) under $HOME.
# Tests that resolve the user's real toolchain (mise/homebrew) read it from
# TMB_TEST_REAL_HOME; the embedding cache stays the shared user cache.
FOOTPRINT_HOME="$(mktemp -d)"
trap 'rm -rf "$FOOTPRINT_HOME"' EXIT
export TMB_TEST_REAL_HOME="$HOME"
export TMB_MODEL_CACHE_DIR="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-$HOME/.cache/huggingface}}"
export HOME="$FOOTPRINT_HOME"

FAILED=0
TOTAL=0

for t in "$HERE"/*.test.sh; do
  [ -f "$t" ] || continue
  TOTAL=$((TOTAL + 1))
  printf "\n=== %s ===\n" "$(basename "$t")"
  if _l5_timeout 120 bash "$t"; then
    :
  else
    rc=$?
    FAILED=$((FAILED + 1))
    if [ "$rc" -eq 124 ]; then
      printf "TIMEOUT %s — killed after 120s\n" "$(basename "$t")"
    fi
  fi
done

LEAKED="$(find "$FOOTPRINT_HOME" -mindepth 1 -print 2>/dev/null | sed "s|^$FOOTPRINT_HOME|\$HOME|")"
if [ -n "$LEAKED" ]; then
  printf "\nFAIL footprint: hook tests wrote under HOME:\n%s\n" "$LEAKED"
  FAILED=$((FAILED + 1))
else
  printf "\nfootprint: HOME untouched by the hook suite\n"
fi

printf "\n"
if [ "$FAILED" -eq 0 ]; then
  printf "All %d hook test files passed.\n" "$TOTAL"
  exit 0
else
  printf "%d of %d hook test files had failures.\n" "$FAILED" "$TOTAL"
  exit 1
fi
