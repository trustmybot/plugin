#!/usr/bin/env bash
# Keeps L3 hook tests bound to their fixture project, never the live one.
#
# Rule: every tests/l3-integration/hooks/*.test.sh that invokes a hook — names
# a top-level scripts/hooks/<hook>.sh, the scripts/hooks dir itself,
# dispatch.sh, or the DB resolver scripts/hooks/lib/query-task.sh — must, outside
# comments, set CLAUDE_PROJECT_DIR or TRAJECTORY_DB_PATH (`export X=...`,
# `X=... bash "$HOOK"`, `env X=...`, an `envs+=(X=...)` entry). `unset X` or
# `env -u X` alone is not a pin. Without one, a hook run outside the test flags
# resolves its DB by walking up from cwd — to the project's live
# .claude/tmb/trajectory.db for any checkout inside the project.
#
# Usage: bash tests/l1-lint/hook-tests-pin-project.sh [--self-test]
# --self-test: fixtures/hook-tests-pin-project/unpinned.test.sh and
# mentioned.test.sh must be flagged; pinned.test.sh and no-hook.test.sh pass.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

INVOKES_HOOK='scripts/hooks/[A-Za-z0-9_.-]+\.sh|scripts/hooks/lib/query-task\.sh|scripts/hooks/?("|$|[[:space:]])|dispatch\.sh'
PINS_PROJECT='(^|[^A-Za-z0-9_])(CLAUDE_PROJECT_DIR|TRAJECTORY_DB_PATH)='

# code_only <file> — the file with comment lines removed.
code_only() {
  sed -E 's/^[[:space:]]*#.*//' "$1"
}

# unpinned_files <dir> — prints each *.test.sh in <dir> that invokes a hook
# without pinning the project.
unpinned_files() {
  local f code
  for f in "$1"/*.test.sh; do
    [ -f "$f" ] || continue
    code=$(code_only "$f")
    printf '%s\n' "$code" | grep -E "$INVOKES_HOOK" >/dev/null || continue
    printf '%s\n' "$code" | grep -E "$PINS_PROJECT" >/dev/null && continue
    printf '%s\n' "$f"
  done
}

if [ "${1:-}" = "--self-test" ]; then
  fixtures="$HERE/fixtures/hook-tests-pin-project"
  ok=1
  for f in unpinned.test.sh mentioned.test.sh pinned.test.sh no-hook.test.sh; do
    [ -f "$fixtures/$f" ] || { printf 'hook-tests-pin-project --self-test: fixture missing: %s\n' "$f" >&2; exit 1; }
  done
  out=$(unpinned_files "$fixtures")
  for f in unpinned.test.sh mentioned.test.sh; do
    case "$out" in
      *"/$f"*) printf 'hook-tests-pin-project --self-test: PASS (%s caught)\n' "$f" ;;
      *) printf 'hook-tests-pin-project --self-test: FAIL (%s not caught)\n' "$f" >&2; ok=0 ;;
    esac
  done
  for f in pinned.test.sh no-hook.test.sh; do
    case "$out" in
      *"/$f"*) printf 'hook-tests-pin-project --self-test: FAIL (%s flagged)\n' "$f" >&2; ok=0 ;;
      *) printf 'hook-tests-pin-project --self-test: PASS (%s passes)\n' "$f" ;;
    esac
  done
  [ "$ok" = 1 ] && exit 0
  exit 1
fi

TEST_DIR="$PLUGIN_ROOT/tests/l3-integration/hooks"
[ -d "$TEST_DIR" ] || { printf 'hook-tests-pin-project: %s missing\n' "$TEST_DIR" >&2; exit 1; }

out=$(unpinned_files "$TEST_DIR")
if [ -n "$out" ]; then
  while IFS= read -r f; do
    printf '%s: invokes a hook without setting CLAUDE_PROJECT_DIR or TRAJECTORY_DB_PATH to its fixture\n' "${f#"$PLUGIN_ROOT/"}"
  done <<< "$out"
  printf '\nhook-tests-pin-project: FAIL\n' >&2
  exit 1
fi

printf 'hook-tests-pin-project: PASS\n'
