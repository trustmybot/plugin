#!/usr/bin/env bash
# Backbone agents (swe, pr-reviewer) no longer ship as template copies —
# templates/agents/swe.md and templates/agents/pr-reviewer.md were deleted.
# This check now verifies those files are absent (not re-introduced as drift).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FAIL=0
for name in swe pr-reviewer; do
  dst="$PLUGIN_ROOT/templates/agents/$name.md"
  if [ -f "$dst" ]; then
    printf 'DRIFT: %s must not exist — backbone agents no longer ship as template copies\n' "$dst" >&2
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  printf 'agent-template-byte-identity: FAIL\n' >&2
  exit 1
fi
printf 'agent-template-byte-identity: OK (backbone template copies absent)\n'
