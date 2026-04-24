#!/usr/bin/env bash
# Enforce the 200-line cap on shipped agent prompts (issue #31).
# Sections that fire on < ~20% of sessions belong in skills, not in the
# agent baseline prompt — see skills/<name>/SKILL.md alongside the agent.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

LIMIT=200
FAIL=0

printf "Enforcing %d-line budget on agents/*.md\n" "$LIMIT"

while IFS= read -r f; do
  lines=$(wc -l < "$f" | tr -d ' ')
  if [ "$lines" -gt "$LIMIT" ]; then
    printf "  ❌ %s: %d lines (over by %d)\n" "$f" "$lines" "$((lines - LIMIT))"
    FAIL=$((FAIL + 1))
  else
    printf "  ✓ %s: %d lines\n" "$f" "$lines"
  fi
done < <(find "$PLUGIN_ROOT/agents" -maxdepth 1 -name '*.md' -type f | sort)

if [ "$FAIL" -eq 0 ]; then
  printf "\nAll agents within budget.\n"
  exit 0
else
  printf "\n%d agent(s) over budget. Extract rarely-triggered sections into skills/.\n" "$FAIL"
  exit 1
fi
