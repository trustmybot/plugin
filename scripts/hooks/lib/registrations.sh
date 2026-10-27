#!/usr/bin/env bash
# How dispatch.sh reads its hooks.json registrations — with awk, so it holds
# on a host without jq.
#
#   tmb_registration <hooks.json> <name>  — "<timeout> <fail-closed 1|0>"
#
# Chains: one hooks.json registration `dispatch.sh <chain>` that
# runs several gates in a fixed order and stops at the first deny. Claude Code
# runs the entries of a matcher in parallel, so ordering lives here.
#
# A chain table has one line per gate, in run order:
#   <gate> <timeout s> <tool>
# <tool> is `*` (every call) or the tool-name suffix after `trajectory-server__`
# the gate runs for. <timeout s> is the gate's own budget: the dispatcher's
# duplicate wait and stale-lock age for that gate. The chain's hooks.json
# timeout covers every `*` gate plus the largest tool-specific one
# (tests/l1-lint/hook-timeout-budget.sh).
#
#   tmb_chain_table <name>              — the table; empty when <name> is no chain
#   tmb_chain_gates <name> <tool_name>  — the gates one call runs, in order

tmb_chain_table() {
  case "$1" in
    trajectory-gates)
      printf '%s\n' \
        'agent-arg-matches-caller 6 *' \
        'swe-brief-gate 6 *' \
        'swe-verification-gate 1830 task_update_status' \
        'reviewer-identity-observe 6 validation_record' \
        'cheatcode-install-approval 6 cheatcode_install'
      ;;
  esac
}

tmb_chain_gates() {
  local gate _timeout tool
  while read -r gate _timeout tool; do
    case "$tool" in
      '*') printf '%s\n' "$gate" ;;
      *) case "$2" in *trajectory-server__"$tool") printf '%s\n' "$gate" ;; esac ;;
    esac
  done < <(tmb_chain_table "$1")
}

# tmb_registration <hooks.json> <name> — "<largest timeout> <1 when any
# registration of `dispatch.sh <name>` carries onFailure block, else 0>".
# Each innermost hook object is the text after the last `{` before a `}`
# once `${VAR}` references and escaped quotes are dropped, whatever its key
# order, so `"${CLAUDE_PLUGIN_ROOT}/…/dispatch.sh" <name>` and the unquoted
# form match alike.
# A gate with no `dispatch.sh <name>` registration that the router serves
# (a `<gate> <budget ms> <kind> <event> <tools>` line of
# mcp/trajectory-server/dist/hooks-router.txt next to <hooks.json>'s plugin
# root) reads "<budget in whole s> <1 when its kind is enforcement>".
tmb_registration() {
  local router
  router="$(dirname "$1")/../mcp/trajectory-server/dist/hooks-router.txt"
  awk -v g="$2" -v router="$router" '
    { s = s $0 "\n" }
    END {
      gsub(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/, "", s)
      gsub(/\\"/, "", s)
      t = ""; b = 0
      while ((e = index(s, "}")) > 0) {
        o = substr(s, 1, e - 1)
        s = substr(s, e + 1)
        while ((k = index(o, "{")) > 0) o = substr(o, k + 1)
        if (index(o, "/dispatch.sh " g "\"") == 0 && index(o, "/dispatch.sh " g " ") == 0) continue
        if (match(o, /"timeout"[[:space:]]*:[[:space:]]*[0-9]+/)) {
          v = substr(o, RSTART, RLENGTH); sub(/.*:[[:space:]]*/, "", v)
          if (t == "" || v + 0 > t + 0) t = v
        }
        if (o ~ /"onFailure"[[:space:]]*:[[:space:]]*"block"/) b = 1
      }
      if (t == "" && b == 0) {
        while ((getline line < router) > 0) {
          split(line, f, " ")
          if (f[1] != g) continue
          t = int((f[2] + 999) / 1000)
          b = (f[3] == "enforcement") ? 1 : 0
          break
        }
      }
      print t " " b
    }' "$1" 2>/dev/null
}

# The router (GH 1692 R1): one exec-form registration per event,
#   node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" <Event>
# runs the gates dist/hooks-router.txt lists for <Event>, in order.
#
#   tmb_router_event <command>             — <Event> when <command> is the router, else nothing
#   tmb_router_gates <plugin root> <Event> — the gates it runs, one per line
tmb_router_event() {
  case "$1" in
    'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" '*)
      local event="${1##* }"
      case "$event" in
        ''|*[!A-Za-z]*) ;;
        *) printf '%s\n' "$event" ;;
      esac
      ;;
  esac
}

tmb_router_gates() {
  awk -v e="$2" '$4 == e { print $1 }' "$1/mcp/trajectory-server/dist/hooks-router.txt" 2>/dev/null
}

#   tmb_router_budget_max <plugin root> <Event> — the largest of its gates' budget ms
tmb_router_budget_max() {
  awk -v e="$2" '$4 == e && $2 + 0 > m { m = $2 + 0 } END { if (m > 0) print m }' "$1/mcp/trajectory-server/dist/hooks-router.txt" 2>/dev/null
}
