#!/usr/bin/env bash
# Lint: every script referenced by a hooks.json command must be executable
# (git mode 100755). CC execs hook commands directly — a 644 hook fails
# with Permission denied and the hook silently never fires.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FAIL=0
CHECKED=0

while IFS= read -r cmd; do
  rel="${cmd#\$\{CLAUDE_PLUGIN_ROOT\}/}"
  [ "$rel" = "$cmd" ] && continue
  rel="${rel%% *}"
  CHECKED=$((CHECKED + 1))
  mode=$(git ls-files -s -- "$rel" | awk '{print $1}')
  if [ -z "$mode" ]; then
    printf "hooks-executable: MISSING from git: %s\n" "$rel" >&2
    FAIL=$((FAIL + 1))
  elif [ "$mode" != "100755" ]; then
    printf "hooks-executable: not executable (mode %s): %s\n" "$mode" "$rel" >&2
    FAIL=$((FAIL + 1))
  fi
done < <(jq -r '.hooks[][]?.hooks[]?.command // empty' hooks/hooks.json | sort -u)

if [ "$FAIL" -gt 0 ] || [ "$CHECKED" -eq 0 ]; then
  [ "$CHECKED" -eq 0 ] && printf "hooks-executable: parsed 0 commands — jq path wrong?\n" >&2
  printf "hooks-executable: FAIL\n"
  exit 1
fi
printf "hooks-executable: %d hook commands checked, all executable.\n" "$CHECKED"
