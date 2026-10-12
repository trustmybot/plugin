#!/usr/bin/env bash
# Lint: every deny-capable hook registration in hooks/hooks.json carries
# "onFailure": "block".
#
# Claude Code treats a command hook that crashes, times out, or exits non-zero
# without valid JSON as "continue" unless its registration says
# "onFailure": "block" — a gate that dies allows the action. The dispatcher
# reads the same key to emit a deny itself when a gate dies (clients older
# than the one honouring the key included).
#
# Deny-capable is derived from the source, never listed by hand. A gate
# `dispatch.sh <gate>` resolves to scripts/hooks/<gate>.sh; it is
# deny-capable when, outside comments, it
#   - prints a deny: "permissionDecision": "deny" or "decision": "block",
#   - exits 2,
#   - calls a function from a library it sources (scripts/hooks/lib/*.sh)
#     whose body prints a deny (tmb_deny_db_unavailable, …), or
#   - runs another scripts/hooks/<name>.sh that is deny-capable.
# FAIL: a deny-capable registration without "onFailure": "block", or an
#       onFailure value other than "block" / "continue".
# WARN: an observe-only registration with "onFailure": "block" (its crash
#       would block the action for nothing).
# Prints the derived table.
#
# Usage: hook-onfailure.sh [--self-test] [<hooks.json> <scripts/hooks dir>]

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

command -v jq >/dev/null 2>&1 || { printf "hook-onfailure: jq required\n" >&2; exit 1; }

DENY_RE='permissionDecision"?[[:space:]]*:[[:space:]]*"deny"|"?decision"?[[:space:]]*:[[:space:]]*"block"|(^|[^a-zA-Z0-9_])exit[[:space:]]+2([^0-9]|$)'

# code <file> — the file without comment lines.
code() { grep -vE '^[[:space:]]*#' "$1" 2>/dev/null || true; }

# deny_functions <lib> — names of the functions in <lib> whose body denies.
deny_functions() {
  awk -v re="$DENY_RE" '
    /^[[:space:]]*#/ { next }
    match($0, /^[a-zA-Z_][a-zA-Z0-9_]*[[:space:]]*\(\)/) {
      fn = $0; sub(/[[:space:]]*\(\).*/, "", fn); next
    }
    /^}/ { fn = ""; next }
    fn != "" && $0 ~ re { print fn }
  ' "$1" | sort -u
}

# deny_capable <dir> <gate> [<seen>...] — exit 0 when <gate> can deny.
deny_capable() {
  local dir="$1" gate="$2"
  shift 2
  local script="$dir/$gate.sh" body lib fn sub s
  [ -f "$script" ] || return 1
  for s in "$@"; do [ "$s" = "$gate" ] && return 1; done
  body=$(code "$script")
  printf '%s\n' "$body" | grep -qE "$DENY_RE" && return 0
  while IFS= read -r lib; do
    [ -f "$dir/lib/$lib" ] || continue
    while IFS= read -r fn; do
      [ -n "$fn" ] || continue
      printf '%s\n' "$body" | grep -qE "(^|[^a-zA-Z0-9_])$fn([^a-zA-Z0-9_(]|$)" && return 0
    done < <(deny_functions "$dir/lib/$lib")
  done < <(printf '%s\n' "$body" | grep -oE '/lib/[a-z0-9-]+\.sh' | sed -E 's#.*/lib/##' | sort -u)
  while IFS= read -r sub; do
    [ "$sub" = "$gate" ] && continue
    deny_capable "$dir" "$sub" "$gate" "$@" && return 0
  done < <(printf '%s\n' "$body" | grep -oE '\$\{?[A-Za-z_]+\}?/[a-z0-9-]+\.sh' | sed -E 's#.*/##; s#\.sh$##' | sort -u)
  return 1
}

# check <hooks.json> <scripts/hooks dir> — prints the table; exit 1 on FAIL.
check() {
  local hooks_json="$1" dir="$2" fail=0 warn=0 n=0
  local event gate on_failure capable status
  printf '%-18s %-34s %-12s %-10s %s\n' EVENT GATE DENY-CAPABLE ONFAILURE STATUS
  while IFS=$'\t' read -r event gate on_failure; do
    n=$((n + 1))
    if [ -z "$gate" ] || [ ! -f "$dir/$gate.sh" ]; then
      printf '%-18s %-34s %-12s %-10s %s\n' "$event" "${gate:-?}" "?" "$on_failure" "FAIL (no scripts/hooks/<gate>.sh)"
      fail=$((fail + 1))
      continue
    fi
    if deny_capable "$dir" "$gate"; then capable=yes; else capable=no; fi
    case "$on_failure" in
      block|continue|-) ;;
      *)
        printf '%-18s %-34s %-12s %-10s %s\n' "$event" "$gate" "$capable" "$on_failure" "FAIL (onFailure must be block or continue)"
        fail=$((fail + 1))
        continue
        ;;
    esac
    status=ok
    if [ "$capable" = yes ] && [ "$on_failure" != block ]; then
      status='FAIL (deny-capable: add "onFailure": "block")'
      fail=$((fail + 1))
    elif [ "$capable" = no ] && [ "$on_failure" = block ]; then
      status='WARN (observe-only: "onFailure": "block" is unnecessary)'
      warn=$((warn + 1))
    fi
    printf '%-18s %-34s %-12s %-10s %s\n' "$event" "$gate" "$capable" "$on_failure" "$status"
  done < <(jq -r '
    .hooks | to_entries[] | .key as $e | .value[]?.hooks[]?
    | [$e, ((.command // "") | capture("/dispatch\\.sh (?<g>[a-z0-9-]+)").g // ""), (.onFailure // "-")]
    | @tsv' "$hooks_json")
  if [ "$n" -eq 0 ]; then
    printf "hook-onfailure: parsed 0 registrations from %s — jq path wrong?\n" "$hooks_json" >&2
    return 1
  fi
  [ "$warn" -gt 0 ] && printf "hook-onfailure: WARN %d observe-only registration(s) carry onFailure: block\n" "$warn" >&2
  if [ "$fail" -gt 0 ]; then
    printf "hook-onfailure: FAIL %d registration(s)\n" "$fail" >&2
    return 1
  fi
  printf "hook-onfailure: PASS — %d registrations, every deny-capable one fails closed\n" "$n"
}

self_test() {
  local fx="$HERE/fixtures/hook-onfailure" dir out rc bad=0
  dir="$fx/scripts/hooks"
  out=$(check "$fx/hooks-missing.json" "$dir" 2>&1); rc=$?
  if [ "$rc" -ne 1 ] || ! printf '%s' "$out" | grep -q 'fx-gate .*FAIL'; then
    printf 'hook-onfailure --self-test: deny-capable hook without the key not failed\n%s\n' "$out" >&2; bad=1
  fi
  out=$(check "$fx/hooks-ok.json" "$dir" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] || printf '%s' "$out" | grep -q WARN; then
    printf 'hook-onfailure --self-test: correct registrations not passed cleanly\n%s\n' "$out" >&2; bad=1
  fi
  for g in fx-gate fx-helper-gate fx-exit2-gate fx-delegator; do
    printf '%s' "$out" | grep -qE "^[A-Za-z]+ +$g +yes " \
      || { printf 'hook-onfailure --self-test: %s not derived deny-capable\n' "$g" >&2; bad=1; }
  done
  printf '%s' "$out" | grep -qE "^[A-Za-z]+ +fx-observe +no " \
    || { printf 'hook-onfailure --self-test: fx-observe not derived observe-only\n' >&2; bad=1; }
  out=$(check "$fx/hooks-warn.json" "$dir" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep -q 'fx-observe .*WARN'; then
    printf 'hook-onfailure --self-test: observe-only hook with the key not warned\n%s\n' "$out" >&2; bad=1
  fi
  if [ "$bad" -ne 0 ]; then
    printf 'hook-onfailure --self-test: FAIL\n' >&2
    return 1
  fi
  printf 'hook-onfailure --self-test: PASS (missing key fails, correct passes, observe-only with the key warns)\n'
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  '') self_test >/dev/null || { self_test; exit 1; }
      check "$ROOT/hooks/hooks.json" "$ROOT/scripts/hooks"; exit $? ;;
  *) check "$1" "${2:-$ROOT/scripts/hooks}"; exit $? ;;
esac
