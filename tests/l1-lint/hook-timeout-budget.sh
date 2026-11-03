#!/usr/bin/env bash
# Lint: each hooks.json wrapper `timeout` must cover the hook's own internal
# budget. CC kills a hook process at the hooks.json timeout — so a hook whose
# internal budget (retry loop, verification total) exceeds its wrapper is
# silently neutered: the process is killed before its budget can elapse.
# This lint derives each gate's worst-case internal budget from its source
# (mcp/trajectory-server/src/hooks/<gate>.ts) and FAILs when its budget doesn't
# cover it, so a future budget bump can't re-neuter a gate without also
# reddening L1. Every registration runs through the router (GH 1692), which
# runs each gate of a group until its own budget (dist/hooks-router.txt), so a
# gate is held to that budget and each group's registration to its group's.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v jq >/dev/null 2>&1 || { printf "hook-timeout-budget: jq required\n" >&2; exit 1; }

HOOKS_JSON="hooks/hooks.json"
HOOKS_SRC="mcp/trajectory-server/src/hooks"
FAIL=0

# shellcheck source=scripts/hooks/lib/registrations.sh
. scripts/hooks/lib/registrations.sh

# Budget of a gate in whole seconds: the smallest of its router budgets.
gate_budget() {
  awk -v g="$1" '$1 == g { print int(($2 + 999) / 1000) }' mcp/trajectory-server/dist/hooks-router.txt 2>/dev/null \
    | sort -n | head -1
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

# --- every gate writing through lib/audit.ts: per-run write budget ----------
# Every DB write in one gate run shares a run budget
# (TMB_DB_WRITE_RUN_BUDGET_MS): the summed time spent writing never exceeds it,
# however many rows the gate writes under a held lock. The effective budget is
# the largest run budget the gate's source sets (`TMB_DB_WRITE_RUN_BUDGET_MS:
# '<ms>'`, or a `…RUN_BUDGET_MS = '<ms>'` constant it passes), else the
# library default. floor = run budget + 1 s margin.
DBW_LIB="$HOOKS_SRC/lib/audit.ts"
DBW_DEFAULT_RUN_MS=$(grep -oE 'DEFAULT_RUN_BUDGET_MS = [0-9]+' "$DBW_LIB" | head -1 | grep -oE '[0-9]+$' || true)
DBW_CHECKED=0
DBW_SUMMARY=""

if require "$DBW_DEFAULT_RUN_MS" "lib/audit.ts default run budget (DEFAULT_RUN_BUDGET_MS)"; then
  for gate_src in "$HOOKS_SRC"/*.ts; do
    grep -qE "from '\./lib/audit\.js'" "$gate_src" || continue
    gate=$(basename "$gate_src" .ts)
    wrap=$(gate_budget "$gate")
    [ -n "$wrap" ] || continue
    ms=$(grep -oE "(TMB_DB_WRITE_RUN_BUDGET_MS: '|RUN_BUDGET_MS = ')[0-9]+" "$gate_src" | grep -oE '[0-9]+$' | sort -n | tail -1 || true)
    [ -n "$ms" ] || ms="$DBW_DEFAULT_RUN_MS"
    floor=$(awk -v ms="$ms" 'BEGIN { printf "%.1f", ms / 1000 + 1 }')
    if awk -v w="$wrap" -v f="$floor" 'BEGIN { exit !(w < f) }'; then
      printf "hook-timeout-budget: FAIL %s budget %ss < floor %ss (run budget %sms + 1s margin)\n" \
        "$gate" "$wrap" "$floor" "$ms" >&2
      FAIL=$((FAIL + 1))
    fi
    DBW_CHECKED=$((DBW_CHECKED + 1))
    DBW_SUMMARY="${DBW_SUMMARY}  ${gate}: budget ${wrap}s >= floor ${floor}s (run budget ${ms}ms)
"
  done
fi

# --- swe-verification-gate: verification budget cap + run-record writes -----
# The gate reads its budget from plugin_config.verification_timeout_s (or
# TMB_VERIFICATION_TIMEOUT_S) and caps it at VERIFICATION_MAX_S; the budget
# counts command time only. The run-record writes are budgeted apart: the start
# and command writes share RECORD_POOL_MS, and the finish write gets
# FINISH_ATTEMPTS tries of RECORD_BUDGET_MS with a backoff of attempt ×
# FINISH_BACKOFF_MS between them. So
#   floor = cap + ceil((POOL + ATTEMPTS × RECORD + BACKOFF × ATTEMPTS ×
#           (ATTEMPTS-1) / 2) / 1000) + VG_OVERHEAD_S
# where VG_OVERHEAD_S covers the reads, the toolchain resolution and the
# decision. The default must sit under the cap.
VG_OVERHEAD_S=5
VG_SRC="$HOOKS_SRC/swe-verification-gate.ts"
VG_WRAP=$(gate_budget swe-verification-gate)
vg_const() { grep -oE "^(export )?const $1 = [0-9]+" "$VG_SRC" | head -1 | grep -oE '[0-9]+$' || true; }
VG_DEFAULT=$(vg_const VERIFICATION_DEFAULT_S)
VG_MAX=$(vg_const VERIFICATION_MAX_S)
VG_RECORD_MS=$(vg_const RECORD_BUDGET_MS)
VG_POOL_MS=$(vg_const RECORD_POOL_MS)
VG_ATTEMPTS=$(vg_const FINISH_ATTEMPTS)
VG_BACKOFF_MS=$(vg_const FINISH_BACKOFF_MS)
VG_FLOOR=""
VG_RECORD_S=""

if require "$VG_WRAP" "swe-verification-gate router budget" \
   && require "$VG_DEFAULT" "verification-gate default budget (VERIFICATION_DEFAULT_S)" \
   && require "$VG_MAX" "verification-gate budget cap (VERIFICATION_MAX_S)" \
   && require "$VG_RECORD_MS" "verification-gate record write budget (RECORD_BUDGET_MS)" \
   && require "$VG_POOL_MS" "verification-gate record pool (RECORD_POOL_MS)" \
   && require "$VG_ATTEMPTS" "verification-gate finish attempts (FINISH_ATTEMPTS)" \
   && require "$VG_BACKOFF_MS" "verification-gate finish backoff (FINISH_BACKOFF_MS)"; then
  VG_RECORD_TOTAL_MS=$(( VG_POOL_MS + VG_ATTEMPTS * VG_RECORD_MS + VG_BACKOFF_MS * VG_ATTEMPTS * (VG_ATTEMPTS - 1) / 2 ))
  VG_RECORD_S=$(( (VG_RECORD_TOTAL_MS + 999) / 1000 ))
  VG_FLOOR=$(( VG_MAX + VG_RECORD_S + VG_OVERHEAD_S ))
  if [ "$VG_WRAP" -lt "$VG_FLOOR" ]; then
    printf "hook-timeout-budget: FAIL swe-verification-gate budget %ss < floor %ss (budget cap %ss + record writes %ss + %ss overhead)\n" \
      "$VG_WRAP" "$VG_FLOOR" "$VG_MAX" "$VG_RECORD_S" "$VG_OVERHEAD_S" >&2
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
done < <(jq -r '.hooks[][]? | (.matcher // "") as $m | .hooks[]? | .command = ((.command // "") | sub("^command -v node >/dev/null 2>&1 \\|\\| \\{ [^}]*\\}; "; "")) | select((.command // "") | test("^node \"\\$\\{CLAUDE_PLUGIN_ROOT\\}/mcp/trajectory-server/dist/hooks\\.js\" [A-Za-z]+( [a-z-]+)?$")) | (.command | capture("hooks\\.js\" (?<e>[A-Za-z]+)( (?<p>[a-z-]+))?$")) as $r | [$r.e, (if $m == "" then "-" else $m end), (.timeout // ""), ($r.p // "")] | @tsv' "$HOOKS_JSON")

if [ "$FAIL" -gt 0 ]; then
  printf "hook-timeout-budget: FAIL\n"
  exit 1
fi
printf "%s" "$ROUTER_SUMMARY"
printf "%s" "$DBW_SUMMARY"
printf "hook-timeout-budget: %s DB-writing gates + verification-gate %ss (floor %ss = cap %ss + record writes %ss + %ss overhead) — budgets cover their writes.\n" \
  "$DBW_CHECKED" "$VG_WRAP" "$VG_FLOOR" "$VG_MAX" "$VG_RECORD_S" "$VG_OVERHEAD_S"
