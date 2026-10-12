#!/usr/bin/env bash
# Run every *.test.sh in tests/l3-integration/hooks/ and aggregate pass/fail.
# Each test file is wrapped with a 120s per-test timeout (240s for SLOW_FILES)
# so a single stuck test reports FAIL and the runner continues. The summary
# names every failing file with its last 10 lines of output.
#
# Usage: run.sh [-v|--verbose]   (-v prints each file's duration)
# L3_HOOKS_TEST_DIR overrides the directory whose *.test.sh files are run.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="${L3_HOOKS_TEST_DIR:-$HERE}"

VERBOSE="${L3_VERBOSE:-0}"
case "${1:-}" in -v|--verbose) VERBOSE=1 ;; esac

DEFAULT_TIMEOUT_S=120
SLOW_TIMEOUT_S=240
# Files measured at 30s or more on an idle machine (`run.sh -v`); under a
# sibling's load they can exceed the default budget.
SLOW_FILES=(
  git-guards.test.sh
  swe-boundary.test.sh
  git-push-guard.test.sh
  roundtable-slash-detect.test.sh
)

file_timeout() {
  local name="$1" slow
  for slow in "${SLOW_FILES[@]}"; do
    [ "$slow" = "$name" ] && { echo "$SLOW_TIMEOUT_S"; return; }
  done
  echo "$DEFAULT_TIMEOUT_S"
}

# Hooks resolve the trajectory DB from CLAUDE_PROJECT_DIR first; a value
# inherited from a Claude Code session would point tests at a live DB.
unset CLAUDE_PROJECT_DIR CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR
. "$HERE/../../l5-l6/lib/timeout-shim.sh"
. "$HERE/../../lib/tmp-footprint.sh"

# Footprint: every test runs with HOME at one empty temp dir and TMPDIR at a
# fresh dir under it; after the suite HOME must hold nothing but that TMPDIR,
# and TMPDIR nothing but the runner's own logs — no hook writes project state
# (or anything) under $HOME or leaves temp files behind. /tmp must gain no
# entry named for this run (tests/lib/tmp-footprint.sh). Tests that resolve the user's real toolchain
# (mise/homebrew) read it from TMB_TEST_REAL_HOME; the embedding cache stays
# the shared user cache.
tmp_footprint_start l3-hooks
FOOTPRINT_HOME="$(mktemp -d "$(tmp_footprint_parent)/$TMB_TEST_RUN_ID-home.XXXXXX")"
RUN_TMPDIR="$FOOTPRINT_HOME/tmp"
RUNNER_LOGS="$RUN_TMPDIR/l3-hooks-runner"
mkdir -p "$RUNNER_LOGS"
export TMB_TEST_REAL_HOME="$HOME"
# mise shims on PATH resolve tools from the real install + config; their own
# state and caches go to the throwaway dir, not the footprint HOME.
TOOL_STATE="$(mktemp -d "$(tmp_footprint_parent)/$TMB_TEST_RUN_ID-tools.XXXXXX")"
trap 'rm -rf "$FOOTPRINT_HOME" "$TOOL_STATE"' EXIT
export MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
export MISE_CONFIG_DIR="${MISE_CONFIG_DIR:-$HOME/.config/mise}"
export MISE_STATE_DIR="$TOOL_STATE/mise-state" MISE_CACHE_DIR="$TOOL_STATE/mise-cache"
export TMB_MODEL_CACHE_DIR="${TMB_MODEL_CACHE_DIR:-${HF_HOME:-$HOME/.cache/huggingface}}"
export HOME="$FOOTPRINT_HOME"
export TMPDIR="$RUN_TMPDIR"

FAILED=0
TOTAL=0
FAILED_FILES=()

for t in "$TEST_DIR"/*.test.sh; do
  [ -f "$t" ] || continue
  TOTAL=$((TOTAL + 1))
  name="$(basename "$t")"
  log="$RUNNER_LOGS/$name.log"
  limit="$(file_timeout "$name")"
  printf "\n=== %s ===\n" "$name"
  started=$(date +%s)
  _l5_timeout "$limit" bash "$t" >"$log" 2>&1
  rc=$?
  cat "$log"
  if [ "$rc" -ne 0 ]; then
    FAILED=$((FAILED + 1))
    FAILED_FILES+=("$name")
    if [ "$rc" -eq 124 ]; then
      printf "TIMEOUT %s — killed after %ss\n" "$name" "$limit" | tee -a "$log"
    fi
  fi
  [ "$VERBOSE" = "1" ] && printf "duration %s: %ss\n" "$name" "$(( $(date +%s) - started ))"
done

LEAKED="$(find "$FOOTPRINT_HOME" -mindepth 1 -path "$RUN_TMPDIR" -prune -o -print 2>/dev/null | sed "s|^$FOOTPRINT_HOME|\$HOME|")"
if [ -n "$LEAKED" ]; then
  printf "\nFAIL footprint: hook tests wrote under HOME:\n%s\n" "$LEAKED"
  FAILED=$((FAILED + 1))
else
  printf "\nfootprint: HOME untouched by the hook suite\n"
fi

LEAKED_TMP="$(find "$RUN_TMPDIR" -mindepth 1 -path "$RUNNER_LOGS" -prune -o -print 2>/dev/null | sed "s|^$RUN_TMPDIR|\$TMPDIR|")"
if [ -n "$LEAKED_TMP" ]; then
  printf "\nFAIL footprint: hook tests left files in TMPDIR:\n%s\n" "$LEAKED_TMP"
  FAILED=$((FAILED + 1))
else
  printf "footprint: TMPDIR left clean by the hook suite\n"
fi

tmp_footprint_check "the hook suite" "$FOOTPRINT_HOME" "$TOOL_STATE" || FAILED=$((FAILED + 1))

if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
  printf "\nFailing test files:\n"
  for name in "${FAILED_FILES[@]}"; do
    printf "\nFAIL %s — last 10 lines:\n" "$name"
    tail -n 10 "$RUNNER_LOGS/$name.log" | sed 's/^/  | /'
  done
fi

printf "\n"
if [ "$FAILED" -eq 0 ]; then
  printf "All %d hook test files passed.\n" "$TOTAL"
  exit 0
else
  printf "%d of %d hook test files had failures.\n" "$FAILED" "$TOTAL"
  if [ "${#FAILED_FILES[@]}" -gt 0 ]; then
    printf "FAIL files: %s\n" "${FAILED_FILES[*]}"
  fi
  exit 1
fi
