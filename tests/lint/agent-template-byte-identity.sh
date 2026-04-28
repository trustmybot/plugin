#!/usr/bin/env bash
# Asserts that agents that ALSO ship as templates stay byte-identical between
# agents/<name>.md and templates/agents/<name>.md. Drift would mean a project
# that opts into the template-copy flow gets a stale agent body.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FAIL=0
for name in swe pr-reviewer; do
  src="$PLUGIN_ROOT/agents/$name.md"
  dst="$PLUGIN_ROOT/templates/agents/$name.md"
  if [ ! -f "$src" ] || [ ! -f "$dst" ]; then
    printf 'MISSING: %s or %s does not exist\n' "$src" "$dst" >&2
    FAIL=1
    continue
  fi
  if ! diff -q "$src" "$dst" >/dev/null; then
    printf 'DRIFT: %s and %s differ\n' "$src" "$dst" >&2
    diff "$src" "$dst" >&2 || true
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  printf 'agent-template-byte-identity: FAIL\n' >&2
  exit 1
fi
printf 'agent-template-byte-identity: OK (swe + pr-reviewer byte-identical)\n'
