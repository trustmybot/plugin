#!/usr/bin/env bash
# Run every *.test.sh in tests/hooks/ and aggregate pass/fail.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=0
TOTAL=0

for t in "$HERE"/*.test.sh; do
  [ -f "$t" ] || continue
  TOTAL=$((TOTAL + 1))
  printf "\n=== %s ===\n" "$(basename "$t")"
  if bash "$t"; then
    :
  else
    FAILED=$((FAILED + 1))
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
