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

# --- roundtable-slash-detect: retry loop worst case -------------------------
SD_SRC="scripts/hooks/roundtable-slash-detect.sh"
SD_WRAP=$(wrapper_timeout "roundtable-slash-detect.sh")
SD_ATTEMPTS=$(grep -oE 'for attempt in [0-9 ]+' "$SD_SRC" | head -1 | sed -E 's/for attempt in //' | wc -w | tr -d ' ')
SD_BUSY_MS=$(grep -oE '\.timeout[[:space:]]+[0-9]+' "$SD_SRC" | head -1 | grep -oE '[0-9]+' | head -1)
SD_SLEEP=$(grep -oE 'sleep[[:space:]]+[0-9.]+' "$SD_SRC" | head -1 | grep -oE '[0-9.]+' | head -1)

if require "$SD_WRAP" "roundtable-slash-detect wrapper timeout" \
   && require "$SD_ATTEMPTS" "slash-detect attempts" \
   && require "$SD_BUSY_MS" "slash-detect busy-timeout" \
   && require "$SD_SLEEP" "slash-detect sleep"; then
  # worst case = attempts * busy-timeout-seconds + attempts * sleep-seconds
  SD_FLOOR=$(awk -v a="$SD_ATTEMPTS" -v ms="$SD_BUSY_MS" -v s="$SD_SLEEP" \
    'BEGIN { w = a * (ms / 1000) + a * s; c = int(w); if (c < w) c++; print c + 2 }')
  if [ "$SD_WRAP" -lt "$SD_FLOOR" ]; then
    printf "hook-timeout-budget: FAIL roundtable-slash-detect wrapper %ss < floor %ss (internal budget %sx%ss busy + %sx%ss sleep)\n" \
      "$SD_WRAP" "$SD_FLOOR" "$SD_ATTEMPTS" "$((SD_BUSY_MS / 1000))" "$SD_ATTEMPTS" "$SD_SLEEP" >&2
    FAIL=$((FAIL + 1))
  fi
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
printf "hook-timeout-budget: slash-detect %ss (floor %ss), verification-gate %ss (floor %ss) — wrappers cover budgets.\n" \
  "$SD_WRAP" "$SD_FLOOR" "$VG_WRAP" "$VG_FLOOR"
