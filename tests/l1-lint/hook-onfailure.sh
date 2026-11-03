#!/usr/bin/env bash
# Lint: every deny-capable hook registration in hooks/hooks.json carries
# "onFailure": "block".
#
# Claude Code treats a command hook that crashes, times out, or exits non-zero
# without valid JSON as "continue" unless its registration says
# "onFailure": "block" — a gate that dies allows the action.
#
# A registration is the router entry (`node "${CLAUDE_PLUGIN_ROOT}/mcp/
# trajectory-server/dist/hooks.js" <Event> [part]`), checked once per gate
# that dist/hooks-router.txt lists for <Event>, that entry's matcher and its
# part, or a direct `node … dist/hooks.js <gate>` entry (liveness-sentinel);
# a leading node guard (`command -v node … || { …; exit 2; }; `, GH 2215) is
# dropped. Each gate is mcp/trajectory-server/src/hooks/<gate>.ts, listed in
# dist/hooks-gates.txt.
#
# Deny-capable is derived from the source, never listed by hand: a gate is
# deny-capable when, outside comments, it builds a deny or calls a function
# from src/hooks/**/*.ts whose body builds a deny or calls such a function
# (denyUnreadable -> denyDbUnavailable, …), derived to a fixpoint, or when its
# `CHAIN` array names a deny-capable gate (agent-spawn-dispatch).
# FAIL: a deny-capable registration without "onFailure": "block", an
#       onFailure value other than "block" / "continue", or a gate with no
#       src/hooks/<gate>.ts in dist/hooks-gates.txt.
# WARN: a registration whose gates are all observe-only carrying
#       "onFailure": "block" (its crash would block the action for nothing).
# Prints the derived table.
#
# Usage: hook-onfailure.sh [--self-test] [<hooks.json> <plugin root>]

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

command -v jq >/dev/null 2>&1 || { printf "hook-onfailure: jq required\n" >&2; exit 1; }

# shellcheck source=scripts/hooks/lib/registrations.sh
. "$ROOT/scripts/hooks/lib/registrations.sh"

TS_DENY_RE="permissionDecision: *'deny'|decision: *'block'|denyDbUnavailable\\("

# ts_source <plugin root> <gate> — the gate's src/hooks/<gate>.ts when
# dist/hooks-gates.txt lists it, else nothing.
ts_source() {
  local mcp="$1/mcp/trajectory-server"
  [ -f "$mcp/src/hooks/$2.ts" ] && grep -qxF "$2" "$mcp/dist/hooks-gates.txt" 2>/dev/null \
    && printf '%s\n' "$mcp/src/hooks/$2.ts"
}

# ts_code <file> — the TypeScript file without // and /** */ comment lines.
ts_code() { grep -vE '^[[:space:]]*(//|/?\*)' "$1" 2>/dev/null || true; }

# ts_deny_functions <src/hooks dir> — names of the functions in
# <dir>/**/*.ts whose body builds a deny or calls one of these functions, to a
# fixpoint. A body runs from its `function <name>(` / `const <name> = (`
# opener to the next `}` at column 0.
ts_deny_functions() {
  local f
  find "$1" -name '*.ts' -type f 2>/dev/null | sort | while IFS= read -r f; do
    ts_code "$f"
    printf '}\n'
  done | TS_DENY_RE="$TS_DENY_RE" awk '
    BEGIN { re = ENVIRON["TS_DENY_RE"] }
    match($0, /^(export[[:space:]]+)?(async[[:space:]]+)?function[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*[(<]/) ||
    match($0, /^(export[[:space:]]+)?const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*(:[^=]*)?=[[:space:]]*(async[[:space:]]+)?\(/) {
      fn = $0
      sub(/^(export[[:space:]]+)?(async[[:space:]]+)?(function|const)[[:space:]]+/, "", fn)
      sub(/[^A-Za-z0-9_$].*/, "", fn)
      names[fn] = 1
      next
    }
    /^}/ { fn = ""; next }
    fn != "" { body[fn] = body[fn] "\n" $0 }
    END {
      for (n in names) if (body[n] ~ re) deny[n] = 1
      do {
        grew = 0
        for (n in names) {
          if (n in deny) continue
          for (d in deny) {
            if (body[n] ~ ("(^|[^A-Za-z0-9_$.])" d "[[:space:]]*\\(")) { deny[n] = 1; grew = 1; break }
          }
        }
      } while (grew)
      for (n in deny) print n
    }
  ' | sort -u
}

# ts_chain <file> — the gate names of the file's `CHAIN` array, one per line.
ts_chain() {
  ts_code "$1" | awk '
    /^(export[[:space:]]+)?const[[:space:]]+CHAIN[^=]*=[[:space:]]*\[/ { on = 1 }
    on { s = $0; while (match(s, /'\''[a-z0-9-]+'\''/)) { print substr(s, RSTART + 1, RLENGTH - 2); s = substr(s, RSTART + RLENGTH) } }
    on && /\];/ { on = 0 }
  '
}

# deny_capable <plugin root> <deny functions> <gate> [<seen>...] — exit 0 when
# <gate> builds a deny, calls a deny function, or chains a deny-capable gate.
deny_capable() {
  local root="$1" fns="$2" gate="$3" src re="$TS_DENY_RE" names sub s
  shift 3
  for s in "$@"; do [ "$s" = "$gate" ] && return 1; done
  src=$(ts_source "$root" "$gate")
  [ -n "$src" ] || return 1
  names=$(printf '%s\n' "$fns" | grep -E '^[A-Za-z_][A-Za-z0-9_]*$' | paste -sd'|' -)
  [ -n "$names" ] && re="$re|(^|[^A-Za-z0-9_\$.])($names)[[:space:]]*\\("
  ts_code "$src" | grep -E "$re" >/dev/null && return 0
  while IFS= read -r sub; do
    deny_capable "$root" "$fns" "$sub" "$gate" "$@" && return 0
  done < <(ts_chain "$src")
  return 1
}

# registrations <hooks.json> — one "<n>\t<event>\t<target>\t<onFailure>" line
# per registration; <target> is a gate, router:<Event>[+<part>]:<matcher>, or
# empty when the command is neither form.
registrations() {
  jq -r '
    [.hooks | to_entries[] | .key as $e | .value[]? | (.matcher // "") as $m | .hooks[]? | [$e, $m, .]]
    | to_entries[] | .key as $n | .value as [$e, $m, $h]
    | [($n | tostring), $e, (($h.command // "") | sub("^command -v node >/dev/null 2>&1 \\|\\| \\{ [^}]*\\}; "; "")
        | (capture("^node \"\\$\\{CLAUDE_PLUGIN_ROOT\\}/mcp/trajectory-server/dist/hooks\\.js\" (?<g>[a-z][a-z0-9-]*)$").g
           // (capture("^node \"\\$\\{CLAUDE_PLUGIN_ROOT\\}/mcp/trajectory-server/dist/hooks\\.js\" (?<r>[A-Z][A-Za-z]+)( (?<p>[a-z-]+))?$") | "router:" + .r + (if .p then "+" + .p else "" end) + ":" + $m)
           // "")), ($h.onFailure // "-")]
    | @tsv' "$1"
}

# gates <plugin root> <target> — the gates a registration runs, one per line.
gates() {
  local routed routed_event routed_part
  case "$2" in
    router:*)
      routed="${2#router:}"
      routed_event="${routed%%:*}"
      routed_part=-
      case "$routed_event" in *+*) routed_part="${routed_event#*+}"; routed_event="${routed_event%%+*}" ;; esac
      tmb_router_gates "$1" "$routed_event" "${routed#*:}" "" "$routed_part"
      ;;
    '') ;;
    *) printf '%s\n' "$2" ;;
  esac
}

# check <hooks.json> <plugin root> — prints the table; exit 1 on FAIL.
check() {
  local hooks_json="$1" root="$2" fail=0 warn=0 n=0
  local _idx event target on_failure gate capable status via fns list any
  fns=$(ts_deny_functions "$root/mcp/trajectory-server/src/hooks")
  printf '%-18s %-34s %-12s %-10s %s\n' EVENT GATE DENY-CAPABLE ONFAILURE STATUS
  while IFS=$'\t' read -r _idx event target on_failure; do
    list=$(gates "$root" "$target")
    via=""
    case "$target" in router:*) via=" (router)" ;; esac
    if [ -z "$list" ]; then
      printf '%-18s %-34s %-12s %-10s %s\n' "$event" "${target:-?}" "?" "$on_failure" "FAIL (no gate)"
      fail=$((fail + 1))
      continue
    fi
    case "$on_failure" in
      block|continue|-) ;;
      *)
        printf '%-18s %-34s %-12s %-10s %s\n' "$event" "$target" "?" "$on_failure" "FAIL (onFailure must be block or continue)"
        fail=$((fail + 1))
        continue
        ;;
    esac
    any=no
    for gate in $list; do
      n=$((n + 1))
      if [ -z "$(ts_source "$root" "$gate")" ]; then
        printf '%-18s %-34s %-12s %-10s %s\n' "$event" "$gate" "?" "$on_failure" "FAIL (no src/hooks/<gate>.ts in dist/hooks-gates.txt)"
        fail=$((fail + 1))
        any=unknown
        continue
      fi
      if deny_capable "$root" "$fns" "$gate"; then capable=yes; any=yes; else capable=no; fi
      status="ok$via"
      if [ "$capable" = yes ] && [ "$on_failure" != block ]; then
        status='FAIL (deny-capable: add "onFailure": "block")'
        fail=$((fail + 1))
      fi
      printf '%-18s %-34s %-12s %-10s %s\n' "$event" "$gate" "$capable" "$on_failure" "$status"
    done
    if [ "$any" = no ] && [ "$on_failure" = block ]; then
      printf '%-18s %-34s %-12s %-10s %s\n' "$event" "$target" no block 'WARN (observe-only: "onFailure": "block" is unnecessary)'
      warn=$((warn + 1))
    fi
  done < <(registrations "$hooks_json")
  if [ "$n" -eq 0 ]; then
    printf "hook-onfailure: parsed 0 gate registrations from %s — jq path wrong?\n" "$hooks_json" >&2
    return 1
  fi
  [ "$warn" -gt 0 ] && printf "hook-onfailure: WARN %d observe-only registration(s) carry onFailure: block\n" "$warn" >&2
  if [ "$fail" -gt 0 ]; then
    printf "hook-onfailure: FAIL %d registration(s)\n" "$fail" >&2
    return 1
  fi
  printf "hook-onfailure: PASS — %d gate registrations, every deny-capable one fails closed\n" "$n"
}

self_test() {
  local fx="$HERE/fixtures/hook-onfailure" out rc bad=0 g
  out=$(check "$fx/hooks-missing.json" "$fx" 2>&1); rc=$?
  if [ "$rc" -ne 1 ] || ! printf '%s' "$out" | grep 'fx-gate .*FAIL (deny-capable' >/dev/null \
     || ! printf '%s' "$out" | grep 'fx-ghost .*FAIL (no src/hooks' >/dev/null; then
    printf 'hook-onfailure --self-test: deny-capable hook without the key, or a gate with no source, not failed\n%s\n' "$out" >&2; bad=1
  fi
  out=$(check "$fx/hooks-ok.json" "$fx" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] || printf '%s' "$out" | grep WARN >/dev/null; then
    printf 'hook-onfailure --self-test: correct registrations not passed cleanly\n%s\n' "$out" >&2; bad=1
  fi
  for g in fx-gate fx-block-gate fx-ts-helper-gate fx-dispatcher; do
    printf '%s' "$out" | grep -E "^[A-Za-z]+ +$g +yes " >/dev/null \
      || { printf 'hook-onfailure --self-test: %s not derived deny-capable\n' "$g" >&2; bad=1; }
  done
  printf '%s' "$out" | grep -E "^[A-Za-z]+ +fx-ts-observe +no " >/dev/null \
    || { printf 'hook-onfailure --self-test: fx-ts-observe not derived observe-only\n' >&2; bad=1; }
  out=$(check "$fx/hooks-warn.json" "$fx" 2>&1); rc=$?
  if [ "$rc" -ne 0 ] || ! printf '%s' "$out" | grep 'router:PreToolUse:Write.*WARN' >/dev/null; then
    printf 'hook-onfailure --self-test: observe-only registration with the key not warned\n%s\n' "$out" >&2; bad=1
  fi
  if [ "$bad" -ne 0 ]; then
    printf 'hook-onfailure --self-test: FAIL\n' >&2
    return 1
  fi
  printf 'hook-onfailure --self-test: PASS (missing key fails, a gate with no source fails, correct passes, observe-only with the key warns)\n'
}

case "${1:-}" in
  --self-test) self_test; exit $? ;;
  '') self_test >/dev/null || { self_test; exit 1; }
      check "$ROOT/hooks/hooks.json" "$ROOT"; exit $? ;;
  *) check "$1" "${2:-$ROOT}"; exit $? ;;
esac
