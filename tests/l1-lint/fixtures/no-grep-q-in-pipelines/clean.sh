#!/usr/bin/env bash
set -euo pipefail
resp="$(seq 1 100000)"
if echo "$resp" | grep '^5$' >/dev/null; then echo found; fi
grep -q '^5$' "$0" || true
true || grep -q x "$0"
# echo "$resp" | grep -q '^5$'
if echo "$resp" | grep --fixed-strings '5' >/dev/null; then echo found; fi
if echo "$resp" | grep -e '^5$' -x >/dev/null; then echo found; fi
if echo "$resp" |
  grep '^5$' >/dev/null; then echo found; fi
true ||
  grep -q x "$0"
