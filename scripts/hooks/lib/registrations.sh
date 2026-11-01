#!/usr/bin/env bash
# How dispatch.sh reads its hooks.json registrations — with awk, so it holds
# on a host without jq.
#
#   tmb_registration <hooks.json> <name>  — "<timeout> <fail-closed 1|0>"
#
# Chains: `dispatch.sh <chain>` runs several gates in a fixed order and stops
# at the first deny. The router's trajectory-server group (GH 1692 R2) runs the
# same gates in-process; this table is what the bash path and the headless shim
# run, and a test holds the two equal.
#
# A chain table has one line per gate, in run order:
#   <gate> <timeout s> <tool>
# <tool> is `*` (every call) or the tool-name suffix after `trajectory-server__`
# the gate runs for. <timeout s> is the gate's own budget: the dispatcher's
# duplicate wait and stale-lock age for that gate.
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
# (a `<gate> <budget ms> <kind> <event> <matcher or -> <tool suffix|*>` line of
# mcp/trajectory-server/dist/hooks-router.txt next to <hooks.json>'s plugin
# root) reads "<budget in whole s> <1 when its kind is enforcement>".
# A chain with no registration reads "<every * gate plus the largest
# tool-specific one, in s> 1": chains fail closed.
tmb_registration() {
  local router table
  router="$(dirname "$1")/../mcp/trajectory-server/dist/hooks-router.txt"
  table=$(tmb_chain_table "$2")
  TMB_CHAIN_TABLE="$table" awk -v g="$2" -v router="$router" '
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
      if (t == "" && b == 0 && ENVIRON["TMB_CHAIN_TABLE"] != "") {
        n = split(ENVIRON["TMB_CHAIN_TABLE"], lines, "\n"); sum = 0; largest = 0
        for (i = 1; i <= n; i++) {
          split(lines[i], f, " ")
          if (f[3] == "*") sum += f[2]; else if (f[2] + 0 > largest) largest = f[2] + 0
        }
        t = sum + largest; b = 1
      }
      print t " " b
    }' "$1" 2>/dev/null
}

# The router (GH 1692): one exec-form registration per matcher group and part,
#   node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" <Event> [<part>]
# runs the gates dist/hooks-router.txt lists for <Event>, that matcher and part,
# in order; a line whose sixth column is not `*` runs only for a tool name ending
# in `trajectory-server__<that column>`. An empty matcher prints as `-`; a seventh
# column is the part, and a default group's line has none.
#
#   tmb_router_event <command> — <Event> when <command> is the router, else nothing
#   tmb_router_part <command> — its <part>, `-` for the default, when <command> is the router
#   tmb_router_gates <plugin root> <Event> [<matcher> [<tool name> [<part or ->]]]
#     — its gates, one per line, once each: every group's, one group's, or the
#       ones that group runs for <tool name>; only that part's when one is given
tmb_router_words() {
  case "$1" in
    'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" '*)
      local rest="${1#'node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" '}"
      local event="${rest%% *}" part=-
      [ "$event" = "$rest" ] || part="${rest#* }"
      case "$event" in ''|*[!A-Za-z]*) return 0 ;; esac
      case "$part" in ''|*[!a-z-]*) return 0 ;; esac
      printf '%s %s\n' "$event" "$part"
      ;;
  esac
}

tmb_router_event() {
  local words
  words=$(tmb_router_words "$1")
  [ -z "$words" ] || printf '%s\n' "${words%% *}"
}

tmb_router_part() {
  local words
  words=$(tmb_router_words "$1")
  [ -z "$words" ] || printf '%s\n' "${words#* }"
}

tmb_router_gates() {
  awk -v e="$2" -v m="${3-}" -v t="${4-}" -v p="${5-}" '
    function serves() { return $6 == "*" || t == "" || (length(t) >= length(s = "trajectory-server__" $6) && substr(t, length(t) - length(s) + 1) == s) }
    function holds() { return p == "" || ($7 == "" ? "-" : $7) == p }
    $4 == e && (m == "" || $5 == m) && holds() && serves() && !seen[$1]++ { print $1 }
  ' "$1/mcp/trajectory-server/dist/hooks-router.txt" 2>/dev/null
}

#   tmb_router_budget_max <plugin root> <Event> <matcher> [<part>] — the largest of that group's gate budgets, in ms
tmb_router_budget_max() {
  awk -v e="$2" -v g="${3:--}" -v p="${4-}" '$4 == e && $5 == g && $7 == p && $2 + 0 > m { m = $2 + 0 } END { if (m > 0) print m }' "$1/mcp/trajectory-server/dist/hooks-router.txt" 2>/dev/null
}
