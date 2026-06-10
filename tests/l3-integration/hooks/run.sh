#!/usr/bin/env bash
# Run every *.test.sh in tests/l3-integration/hooks/ and aggregate pass/fail.
# Each test file is wrapped with a 120s per-test timeout so a single stuck
# test reports FAIL and the runner continues.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../l5-l6/lib/timeout-shim.sh"

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

printf "\n"
if [ "$FAILED" -eq 0 ]; then
  printf "All %d hook test files passed.\n" "$TOTAL"
  exit 0
else
  printf "%d of %d hook test files had failures.\n" "$FAILED" "$TOTAL"
  exit 1
fi
