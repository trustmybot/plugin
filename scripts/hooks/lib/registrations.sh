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
# once `${VAR}` references are dropped, whatever its key order.
tmb_registration() {
  awk -v g="$2" '
    { s = s $0 "\n" }
    END {
      gsub(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/, "", s)
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
      print t " " b
    }' "$1" 2>/dev/null
}
