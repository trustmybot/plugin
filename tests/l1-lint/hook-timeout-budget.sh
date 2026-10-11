#!/usr/bin/env bash
# Lint: each hooks.json wrapper `timeout` must cover the hook's own internal
# budget. CC kills a hook process at the hooks.json timeout — so a hook whose
# internal budget (retry loop, verification total) exceeds its wrapper is
# silently neutered: the process is killed before its budget can elapse.
# This lint derives each hook's worst-case internal budget from its source and
# FAILs when the wrapper doesn't cover it, so a future budget bump can't
# re-neuter a hook without also reddening L1.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v jq >/dev/null 2>&1 || { printf "hook-timeout-budget: jq required\n" >&2; exit 1; }

HOOKS_JSON="hooks/hooks.json"
FAIL=0

# Wrapper timeout for a hook command, matched by basename.
wrapper_timeout() {
  jq -r --arg b "$1" '
    [.hooks[][]?.hooks[]? | select((.command // "") | endswith("/" + $b)) | .timeout]
    | first // empty
  ' "$HOOKS_JSON"
}

require() {
  # require <value> <name-for-error>
  if [ -z "$1" ]; then
    printf "hook-timeout-budget: could not derive %s from source\n" "$2" >&2
    FAIL=$((FAIL + 1))
    return 1
  fi
  return 0
}

# --- every hook sourcing db-write.sh: write-retry worst case ----------------
# tmb_db_write waits up to the effective busy timeout per attempt, with a
# backoff between attempts. The effective timeout is the hook's own
# `export TMB_DB_WRITE_TIMEOUT_MS=<ms>` when present, else the library default.
# floor = attempts x timeout + (attempts - 1) x backoff + 1 s margin.
DBW_LIB="scripts/hooks/lib/db-write.sh"
DBW_ATTEMPTS=$(grep -oE '^_TMB_DB_WRITE_ATTEMPTS="[0-9 ]+"' "$DBW_LIB" | head -1 | sed -E 's/^[^"]*"//; s/"$//' | wc -w | tr -d ' ')
DBW_DEFAULT_MS=$(grep -oE 'TMB_DB_WRITE_TIMEOUT_MS:-[0-9]+' "$DBW_LIB" | head -1 | grep -oE '[0-9]+$')
DBW_BACKOFF=$(grep -oE '^_TMB_DB_WRITE_BACKOFF_S=[0-9.]+' "$DBW_LIB" | head -1 | grep -oE '[0-9.]+$')
DBW_CHECKED=0
DBW_SUMMARY=""

if require "$DBW_ATTEMPTS" "db-write attempts" \
   && require "$DBW_DEFAULT_MS" "db-write default busy timeout" \
   && require "$DBW_BACKOFF" "db-write backoff"; then
  for hook in scripts/hooks/*.sh; do
    grep -q 'lib/db-write\.sh' "$hook" || continue
    base=$(basename "$hook")
    wrap=$(wrapper_timeout "$base")
    [ -n "$wrap" ] || continue
    ms=$(grep -oE '^[[:space:]]*export TMB_DB_WRITE_TIMEOUT_MS=[0-9]+' "$hook" | head -1 | grep -oE '[0-9]+$' || true)
    [ -n "$ms" ] || ms="$DBW_DEFAULT_MS"
    floor=$(awk -v a="$DBW_ATTEMPTS" -v ms="$ms" -v b="$DBW_BACKOFF" \
      'BEGIN { printf "%.1f", a * (ms / 1000) + (a - 1) * b + 1 }')
    if awk -v w="$wrap" -v f="$floor" 'BEGIN { exit !(w < f) }'; then
      printf "hook-timeout-budget: FAIL %s wrapper %ss < floor %ss (%s x %sms busy + backoff %ss + 1s margin)\n" \
        "$base" "$wrap" "$floor" "$DBW_ATTEMPTS" "$ms" "$DBW_BACKOFF" >&2
      FAIL=$((FAIL + 1))
    fi
    DBW_CHECKED=$((DBW_CHECKED + 1))
    DBW_SUMMARY="${DBW_SUMMARY}  ${base}: wrapper ${wrap}s >= floor ${floor}s (busy ${ms}ms)
"
  done
fi

# --- swe-verification-gate: total budget default ----------------------------
VG_SRC="scripts/hooks/swe-verification-gate.sh"
VG_WRAP=$(wrapper_timeout "swe-verification-gate.sh")
VG_BUDGET=$(grep -oE 'TMB_VERIFICATION_TIMEOUT_S:-[0-9]+' "$VG_SRC" | head -1 | grep -oE '[0-9]+$')

if require "$VG_WRAP" "swe-verification-gate wrapper timeout" \
   && require "$VG_BUDGET" "verification-gate default budget"; then
  VG_FLOOR=$((VG_BUDGET + 30))
  if [ "$VG_WRAP" -lt "$VG_FLOOR" ]; then
    printf "hook-timeout-budget: FAIL swe-verification-gate wrapper %ss < floor %ss (default budget %ss + 30s margin)\n" \
      "$VG_WRAP" "$VG_FLOOR" "$VG_BUDGET" >&2
    FAIL=$((FAIL + 1))
  fi
fi

if [ "$FAIL" -gt 0 ]; then
  printf "hook-timeout-budget: FAIL\n"
  exit 1
fi
printf "%s" "$DBW_SUMMARY"
printf "hook-timeout-budget: %s db-write hooks + verification-gate %ss (floor %ss) — wrappers cover budgets.\n" \
  "$DBW_CHECKED" "$VG_WRAP" "$VG_FLOOR"
