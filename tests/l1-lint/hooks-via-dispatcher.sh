#!/usr/bin/env bash
# Lint: every hooks/hooks.json command is
#   "${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" <gate>
# (the placeholder quoted, so a plugin root with a space stays one word)
# and scripts/hooks/<gate>.sh exists and is executable (git mode 100755). A
# chain name (scripts/hooks/lib/registrations.sh) stands for its gates: each
# of them must exist and be executable. A gate born in TypeScript has no .sh:
# its src/hooks/<gate>.ts exists and dist/hooks-gates.txt lists it.
# The dispatcher is what makes one gate execution per event hold however many
# registrations fire; a registration that calls a gate directly bypasses it.
# The one other form is the router (GH 1692 R1),
#   node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" <Event> [part],
# which holds the same per-call dedupe: each gate dist/hooks-router.txt lists
# for <Event> and that part must have a .sh or a src/hooks TypeScript source.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v jq >/dev/null 2>&1 || { printf "hooks-via-dispatcher: jq required\n" >&2; exit 1; }

# shellcheck source=scripts/hooks/lib/registrations.sh
. scripts/hooks/lib/registrations.sh

# ts_only <gate> — a gate born in TypeScript: no .sh, but its
# mcp/trajectory-server/src/hooks/<gate>.ts exists and dist/hooks-gates.txt
# lists it, so dispatch.sh runs it through node dist/hooks.js.
ts_only() {
  [ -f "mcp/trajectory-server/src/hooks/$1.ts" ] && grep -qxF "$1" mcp/trajectory-server/dist/hooks-gates.txt 2>/dev/null
}

FAIL=0
CHECKED=0
GATES=0
PREFIX='"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh" '

while IFS= read -r cmd; do
  CHECKED=$((CHECKED + 1))
  event=$(tmb_router_event "$cmd")
  if [ -n "$event" ]; then
    members=$(tmb_router_gates "$ROOT" "$event" "" "" "$(tmb_router_part "$cmd")")
    if [ -z "$members" ]; then
      printf "hooks-via-dispatcher: router entry for %s, but dist/hooks-router.txt lists no %s gate: %s\n" "$event" "$event" "$cmd" >&2
      FAIL=$((FAIL + 1))
    fi
    for g in $members; do
      GATES=$((GATES + 1))
      [ -f "scripts/hooks/$g.sh" ] || ts_only "$g" || [ -f "mcp/trajectory-server/src/hooks/$g.ts" ] || {
        printf "hooks-via-dispatcher: router gate has no source: %s\n" "$g" >&2
        FAIL=$((FAIL + 1))
      }
    done
    continue
  fi
  gate="${cmd#"$PREFIX"}"
  if [ "$gate" = "$cmd" ]; then
    printf "hooks-via-dispatcher: not routed through dispatch.sh: %s\n" "$cmd" >&2
    FAIL=$((FAIL + 1))
    continue
  fi
  case "$gate" in
    ''|*[!a-z0-9-]*|dispatch)
      printf "hooks-via-dispatcher: bad gate name in: %s\n" "$cmd" >&2
      FAIL=$((FAIL + 1))
      continue
      ;;
  esac
  members=$(tmb_chain_table "$gate" | cut -d' ' -f1)
  for g in ${members:-$gate}; do
    GATES=$((GATES + 1))
    rel="scripts/hooks/$g.sh"
    if [ ! -f "$rel" ] && ts_only "$g"; then
      continue
    fi
    mode=$(git ls-files -s -- "$rel" | awk '{print $1}')
    if [ ! -f "$rel" ]; then
      printf "hooks-via-dispatcher: gate script missing: %s\n" "$rel" >&2
      FAIL=$((FAIL + 1))
    elif [ ! -x "$rel" ] || { [ -n "$mode" ] && [ "$mode" != "100755" ]; }; then
      printf "hooks-via-dispatcher: gate script not executable: %s\n" "$rel" >&2
      FAIL=$((FAIL + 1))
    fi
  done
done < <(jq -r '.hooks[][]?.hooks[]? | .command // ""' hooks/hooks.json)

if [ ! -x scripts/hooks/dispatch.sh ]; then
  printf "hooks-via-dispatcher: scripts/hooks/dispatch.sh missing or not executable\n" >&2
  FAIL=$((FAIL + 1))
fi

if [ "$FAIL" -gt 0 ] || [ "$CHECKED" -eq 0 ]; then
  [ "$CHECKED" -eq 0 ] && printf "hooks-via-dispatcher: parsed 0 commands — jq path wrong?\n" >&2
  printf "hooks-via-dispatcher: FAIL\n"
  exit 1
fi
printf "hooks-via-dispatcher: %d registrations route through dispatch.sh to %d executable gate runs.\n" "$CHECKED" "$GATES"
