#!/usr/bin/env bash
# Enforce caps on agent prompts.
#
# Plugin ships ZERO agents under agents/ (it's intentionally empty — bro is
# a persona in CLAUDE.md). All shipped agents live as Lego templates under
# templates/agents/ and follow a much tighter 30-line cap (Lego rule:
# identity + role + boundary + "rest comes from skills").
#
# Project-local agents (after tmb_bootstrap or tmb_agent-creator copies a
# template) are ignored by this lint — they live outside the plugin.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

TEMPLATE_LIMIT=30
SHIPPED_LIMIT=200    # only used if anything ever ships under agents/
FAIL=0

# 1. agents/ should be empty (only .gitkeep allowed).
shipped_agents=$(find "$PLUGIN_ROOT/agents" -maxdepth 1 -name '*.md' -type f | sort)
if [ -n "$shipped_agents" ]; then
  printf "Plugin ships agents (should be empty — Lego rule):\n"
  for f in $shipped_agents; do
    lines=$(wc -l < "$f" | tr -d ' ')
    printf "  ⚠️  %s: %d lines (plugin should ship NO agents)\n" "$f" "$lines"
    if [ "$lines" -gt "$SHIPPED_LIMIT" ]; then
      FAIL=$((FAIL + 1))
    fi
  done
  printf "\n"
fi

# 2. templates/agents/ — Lego cap (≤30 lines).
printf "Enforcing %d-line Lego cap on templates/agents/*.md\n" "$TEMPLATE_LIMIT"
while IFS= read -r f; do
  lines=$(wc -l < "$f" | tr -d ' ')
  if [ "$lines" -gt "$TEMPLATE_LIMIT" ]; then
    printf "  ❌ %s: %d lines (over Lego cap by %d)\n" "$f" "$lines" "$((lines - TEMPLATE_LIMIT))"
    FAIL=$((FAIL + 1))
  else
    printf "  ✓ %s: %d lines\n" "$f" "$lines"
  fi
done < <(find "$PLUGIN_ROOT/templates/agents" -maxdepth 1 -name '*.md' -type f 2>/dev/null | sort)

if [ "$FAIL" -eq 0 ]; then
  printf "\nAll agent templates within Lego cap.\n"
  exit 0
else
  printf "\n%d agent file(s) over budget.\n" "$FAIL"
  exit 1
fi
