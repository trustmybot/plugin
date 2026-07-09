#!/usr/bin/env bash
# Lint: every tests/l3-integration/hooks/*.test.sh that sources lib/assert.sh
# must call `summarize`. assert.sh's _fail only bumps a counter and returns 0;
# summarize is the sole function that returns non-zero on a failed assertion.
# A file that sources assert.sh but never calls summarize exits 0 even when its
# assertions FAIL, so its guard is unenforced (#1015).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FAIL=0
CHECKED=0

for t in tests/l3-integration/hooks/*.test.sh; do
  [ -f "$t" ] || continue
  grep -q 'lib/assert.sh' "$t" || continue
  CHECKED=$((CHECKED + 1))
  if ! grep -Eq '(^|[^A-Za-z_])summarize([^A-Za-z_]|$)' "$t"; then
    printf "test-summarize-present: sources assert.sh but never calls summarize: %s\n" "$t" >&2
    FAIL=$((FAIL + 1))
  fi
done

if [ "$FAIL" -gt 0 ] || [ "$CHECKED" -eq 0 ]; then
  [ "$CHECKED" -eq 0 ] && printf "test-summarize-present: matched 0 files — glob wrong?\n" >&2
  printf "test-summarize-present: FAIL\n"
  exit 1
fi
printf "test-summarize-present: %d assert-sourcing test files checked, all call summarize.\n" "$CHECKED"
