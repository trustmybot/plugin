#!/usr/bin/env bash
# Lint: every script referenced by a hooks.json command must be executable
# (git mode 100755). CC execs hook commands directly — a 644 hook fails
# with Permission denied and the hook silently never fires. A router command
# execs node: a built (git-ignored) bundle must be on disk after the build, a
# hand-written one only has to be tracked.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

FAIL=0
CHECKED=0
router_re='(^|[;&|[:space:]])node "\$\{CLAUDE_PLUGIN_ROOT\}/([^"]+)"'

while IFS= read -r cmd; do
  if [[ "$cmd" =~ $router_re ]]; then
    rel="${BASH_REMATCH[2]}"
    CHECKED=$((CHECKED + 1))
    if git check-ignore -q -- "$rel"; then
      if [ ! -f "$rel" ]; then
        printf "hooks-executable: MISSING built bundle (run bun run build:payload): %s\n" "$rel" >&2
        FAIL=$((FAIL + 1))
      fi
    elif [ -z "$(git ls-files -s -- "$rel")" ]; then
      printf "hooks-executable: MISSING from git: %s\n" "$rel" >&2
      FAIL=$((FAIL + 1))
    fi
    continue
  fi
  unquoted="${cmd#\"}"
  rel="${unquoted#\$\{CLAUDE_PLUGIN_ROOT\}/}"
  [ "$rel" = "$unquoted" ] && continue
  if [ "$unquoted" != "$cmd" ]; then rel="${rel%%\"*}"; else rel="${rel%% *}"; fi
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
