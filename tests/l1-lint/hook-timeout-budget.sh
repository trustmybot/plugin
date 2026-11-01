#!/usr/bin/env bash
# Lint: each hooks.json wrapper `timeout` must cover the hook's own internal
# budget. CC kills a hook process at the hooks.json timeout — so a hook whose
# internal budget (retry loop, verification total) exceeds its wrapper is
# silently neutered: the process is killed before its budget can elapse.
# This lint derives each hook's worst-case internal budget from its source and
# FAILs when the wrapper doesn't cover it, so a future budget bump can't
# re-neuter a hook without also reddening L1. A registration runs through
# scripts/hooks/dispatch.sh, which adds DISPATCH_OVERHEAD_S to each floor, or
# through the router (GH 1692), which runs each gate of a group until its own
# budget (dist/hooks-router.txt), and a router gate is held to that budget.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v jq >/dev/null 2>&1 || { printf "hook-timeout-budget: jq required\n" >&2; exit 1; }

HOOKS_JSON="hooks/hooks.json"
DISPATCH_OVERHEAD_S=1
FAIL=0

# shellcheck source=scripts/hooks/lib/registrations.sh
. scripts/hooks/lib/registrations.sh

# Wrapper timeout for a gate script basename: the smallest of its
# `dispatch.sh <gate>` registrations and its router budget in whole seconds.
wrapper_timeout() {
  local g="${1%.sh}"
  {
    jq -r --arg g "$g" '
      .hooks[][]?.hooks[]? | select((.command // "") | test("/dispatch\\.sh\"? " + $g + "$")) | .timeout // empty
    ' "$HOOKS_JSON"
    awk -v g="$g" '$1 == g { print int(($2 + 999) / 1000) }' mcp/trajectory-server/dist/hooks-router.txt 2>/dev/null
  } | sort -n | head -1
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

# --- every hook sourcing db-write.sh: per-run write budget ----------------
# Every tmb_db_write call in one hook process shares a run budget
# (TMB_DB_WRITE_RUN_BUDGET_MS): the summed time spent writing never exceeds it,
# however many rows the hook writes under a held lock. The effective budget is
# the hook's own `export TMB_DB_WRITE_RUN_BUDGET_MS=<ms>` when present, else
# the library default. floor = run budget + 1 s margin + dispatcher overhead.
DBW_LIB="scripts/hooks/lib/db-write.sh"
DBW_DEFAULT_RUN_MS=$(grep -oE 'TMB_DB_WRITE_RUN_BUDGET_MS:-[0-9]+' "$DBW_LIB" | head -1 | grep -oE '[0-9]+$' || true)
DBW_CHECKED=0
DBW_SUMMARY=""

if require "$DBW_DEFAULT_RUN_MS" "db-write default run budget"; then
  for hook in scripts/hooks/*.sh; do
    grep -q 'lib/db-write\.sh' "$hook" || continue
    base=$(basename "$hook")
    wrap=$(wrapper_timeout "$base")
    [ -n "$wrap" ] || continue
    ms=$(grep -oE '^[[:space:]]*export TMB_DB_WRITE_RUN_BUDGET_MS=[0-9]+' "$hook" | head -1 | grep -oE '[0-9]+$' || true)
    [ -n "$ms" ] || ms="$DBW_DEFAULT_RUN_MS"
    floor=$(awk -v ms="$ms" -v d="$DISPATCH_OVERHEAD_S" 'BEGIN { printf "%.1f", ms / 1000 + 1 + d }')
    if awk -v w="$wrap" -v f="$floor" 'BEGIN { exit !(w < f) }'; then
      printf "hook-timeout-budget: FAIL %s wrapper %ss < floor %ss (run budget %sms + 1s margin + %ss dispatcher)\n" \
        "$base" "$wrap" "$floor" "$ms" "$DISPATCH_OVERHEAD_S" >&2
      FAIL=$((FAIL + 1))
    fi
    DBW_CHECKED=$((DBW_CHECKED + 1))
    DBW_SUMMARY="${DBW_SUMMARY}  ${base}: wrapper ${wrap}s >= floor ${floor}s (run budget ${ms}ms)
"
  done
fi

# --- swe-verification-gate: verification budget cap + run-record writes -----
# The gate reads its budget from plugin_config.verification_timeout_s (or
# TMB_VERIFICATION_TIMEOUT_S) and caps it at VERIFICATION_MAX_S; the budget
# counts command time only. The run-record writes are budgeted apart: the start
# and command writes share VERIFICATION_RECORD_POOL_MS, and the finish write
# gets VERIFICATION_FINISH_ATTEMPTS tries of VERIFICATION_RECORD_BUDGET_MS with
# a backoff of attempt × VERIFICATION_FINISH_BACKOFF_MS between them. So
#   floor = cap + ceil((POOL + ATTEMPTS × RECORD + BACKOFF × ATTEMPTS ×
#           (ATTEMPTS-1) / 2) / 1000) + dispatcher + VG_OVERHEAD_S
# where VG_OVERHEAD_S covers the reads, the toolchain resolution and the
# decision. The default must sit under the cap.
VG_OVERHEAD_S=5
VG_SRC="scripts/hooks/swe-verification-gate.sh"
VG_WRAP=$(wrapper_timeout "swe-verification-gate.sh")
vg_const() { grep -oE "^$1=[0-9]+" "$VG_SRC" | head -1 | grep -oE '[0-9]+$' || true; }
VG_DEFAULT=$(vg_const VERIFICATION_DEFAULT_S)
VG_MAX=$(vg_const VERIFICATION_MAX_S)
VG_RECORD_MS=$(vg_const VERIFICATION_RECORD_BUDGET_MS)
VG_POOL_MS=$(vg_const VERIFICATION_RECORD_POOL_MS)
VG_ATTEMPTS=$(vg_const VERIFICATION_FINISH_ATTEMPTS)
VG_BACKOFF_MS=$(vg_const VERIFICATION_FINISH_BACKOFF_MS)
VG_FLOOR=""
VG_RECORD_S=""

if require "$VG_WRAP" "swe-verification-gate wrapper timeout" \
   && require "$VG_DEFAULT" "verification-gate default budget (VERIFICATION_DEFAULT_S)" \
   && require "$VG_MAX" "verification-gate budget cap (VERIFICATION_MAX_S)" \
   && require "$VG_RECORD_MS" "verification-gate record write budget (VERIFICATION_RECORD_BUDGET_MS)" \
   && require "$VG_POOL_MS" "verification-gate record pool (VERIFICATION_RECORD_POOL_MS)" \
   && require "$VG_ATTEMPTS" "verification-gate finish attempts (VERIFICATION_FINISH_ATTEMPTS)" \
   && require "$VG_BACKOFF_MS" "verification-gate finish backoff (VERIFICATION_FINISH_BACKOFF_MS)"; then
  VG_RECORD_TOTAL_MS=$(( VG_POOL_MS + VG_ATTEMPTS * VG_RECORD_MS + VG_BACKOFF_MS * VG_ATTEMPTS * (VG_ATTEMPTS - 1) / 2 ))
  VG_RECORD_S=$(( (VG_RECORD_TOTAL_MS + 999) / 1000 ))
  VG_FLOOR=$(( VG_MAX + VG_RECORD_S + DISPATCH_OVERHEAD_S + VG_OVERHEAD_S ))
  if [ "$VG_WRAP" -lt "$VG_FLOOR" ]; then
    printf "hook-timeout-budget: FAIL swe-verification-gate wrapper %ss < floor %ss (budget cap %ss + record writes %ss + %ss dispatcher + %ss overhead)\n" \
      "$VG_WRAP" "$VG_FLOOR" "$VG_MAX" "$VG_RECORD_S" "$DISPATCH_OVERHEAD_S" "$VG_OVERHEAD_S" >&2
    FAIL=$((FAIL + 1))
  fi
  if [ "$VG_DEFAULT" -gt "$VG_MAX" ]; then
    printf "hook-timeout-budget: FAIL swe-verification-gate default budget %ss exceeds its cap %ss\n" "$VG_DEFAULT" "$VG_MAX" >&2
    FAIL=$((FAIL + 1))
  fi
fi

# --- the router: its registration covers the parse and the group budget -----
# The router (GH 1692) runs a group's gates one after another after the shared
# parse, each until the smaller of its own budget (dist/hooks-router.txt) and
# the group budget left (budgets.json), so each group's registration timeout is
# the backstop over the parse allowance plus its group budget, and the group
# budget leaves every gate its whole budget when it runs first.
ROUTER_BUDGETS="mcp/trajectory-server/src/hooks/router/budgets.json"
ROUTER_SUMMARY=""
# An empty matcher arrives as `-`, as read would collapse an empty tab-separated field.
while IFS=$'\t' read -r event column wrap part; do
  matcher="${column#-}"
  max=$(tmb_router_budget_max "$ROOT" "$event" "$matcher" "$part")
  parse=$(jq -r '.parse_allowance_ms // empty' "$ROUTER_BUDGETS" 2>/dev/null || true)
  group=$(jq -r --arg m "$event:$matcher${part:+:$part}" '.groups[$m].group_budget_ms // empty' "$ROUTER_BUDGETS" 2>/dev/null || true)
  if ! require "$max" "$event $matcher router gate budgets (dist/hooks-router.txt)" || ! require "$parse" "router parse_allowance_ms ($ROUTER_BUDGETS)" || ! require "$group" "router group_budget_ms of $matcher ($ROUTER_BUDGETS)"; then
    continue
  fi
  if [ "$group" -lt "$max" ]; then
    printf "hook-timeout-budget: FAIL router %s %s group budget %sms < its largest gate budget %sms\n" "$event" "$matcher" "$group" "$max" >&2
    FAIL=$((FAIL + 1))
  fi
  need=$(( (parse + group + 999) / 1000 ))
  if [ "${wrap:-0}" -lt "$need" ]; then
    printf "hook-timeout-budget: FAIL router %s %s wrapper %ss < %ss (parse allowance %sms + group budget %sms)\n" "$event" "$matcher" "${wrap:-?}" "$need" "$parse" "$group" >&2
    FAIL=$((FAIL + 1))
  fi
  ROUTER_SUMMARY="${ROUTER_SUMMARY}  router ${event} ${matcher}: wrapper ${wrap}s >= parse allowance ${parse}ms + group budget ${group}ms (>= largest gate budget ${max}ms)
"
done < <(jq -r '.hooks[][]? | (.matcher // "") as $m | .hooks[]? | select((.command // "") | test("^node \"\\$\\{CLAUDE_PLUGIN_ROOT\\}/mcp/trajectory-server/dist/hooks\\.js\" [A-Za-z]+( [a-z-]+)?$")) | (.command | capture("hooks\\.js\" (?<e>[A-Za-z]+)( (?<p>[a-z-]+))?$")) as $r | [$r.e, (if $m == "" then "-" else $m end), (.timeout // ""), ($r.p // "")] | @tsv' "$HOOKS_JSON")

if [ "$FAIL" -gt 0 ]; then
  printf "hook-timeout-budget: FAIL\n"
  exit 1
fi
printf "%s" "$ROUTER_SUMMARY"
printf "%s" "$DBW_SUMMARY"
printf "hook-timeout-budget: %s db-write hooks + verification-gate %ss (floor %ss = cap %ss + record writes %ss + %ss dispatcher + %ss overhead) — wrappers cover budgets.\n" \
  "$DBW_CHECKED" "$VG_WRAP" "$VG_FLOOR" "$VG_MAX" "$VG_RECORD_S" "$DISPATCH_OVERHEAD_S" "$VG_OVERHEAD_S"
