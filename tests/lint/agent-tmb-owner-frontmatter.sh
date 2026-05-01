#!/usr/bin/env bash
# Verify every plugin-shipped agent has `tmb_owner: bro` in YAML frontmatter.
# Convention enforcement (#22 / TRU-72).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

fail=0
for f in "$PLUGIN_ROOT"/agents/*.md "$PLUGIN_ROOT"/templates/agents/*.md; do
  [ -f "$f" ] || continue
  if ! head -25 "$f" | grep -qE '^tmb_owner:[[:space:]]*bro[[:space:]]*$'; then
    printf '✗ %s missing `tmb_owner: bro` in frontmatter\n' "$f" >&2
    fail=1
  fi
done

if [ "$fail" = "1" ]; then
  printf '\nPlugin-shipped agents must declare `tmb_owner: bro` in frontmatter.\n' >&2
  printf 'See docs/AGENTS.md § "Agent ownership states".\n' >&2
  exit 1
fi

echo "agent-tmb-owner-frontmatter: PASS"
