#!/usr/bin/env bash
# Lint: the docs/reference/REFERENCE.md hook table and hooks/hooks.json agree
# both ways. Every row is a `<name>.ts` naming a gate source under
# mcp/trajectory-server/src/hooks/ that hooks.json registers (a gate
# dist/hooks-router.txt lists for a router entry's event, or the Stop entry
# `dist/hooks.js liveness-sentinel`, the one registration outside the router),
# so a deleted or unwired hook cannot leave a stale row; every hook hooks.json
# registers has a row. scripts/hooks/README.md opens its entry-point section
# with the router as every registration but that sentinel, and never names
# the retired dispatch.sh (GH 1692).
#
# Usage: hooks-doc-fresh.sh [<root>]   (default: this repo; self-tests first)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
HOOKS_SRC="mcp/trajectory-server/src/hooks"
README_ROUTER='Every `hooks/hooks.json` command is the TypeScript router, `node dist/hooks.js <Event> [part]`'
README_STALE='dispatch.sh'

# registered <root> — every gate hooks.json runs, the router entries
# (their dist/hooks-router.txt gates) expanded.
registered() {
  local name
  {
    for name in $(grep -oE 'dist/hooks\.js\\" [A-Za-z]+' "$1/hooks/hooks.json" | sed -E 's/.* //' | sort -u); do
      tmb_router_gates "$1" "$name"
    done
    grep -oE 'dist/hooks\.js\\" [a-z][a-z0-9-]*"' "$1/hooks/hooks.json" | sed -E 's/.* (.*)"/\1/'
  } | sort -u
}

# rows <root> — the `<name>.<ext>` cells of the REFERENCE.md hook table.
rows() {
  awk '/^## Hooks/{on=1; next} on && /^## /{on=0} on' "$1/docs/reference/REFERENCE.md" \
    | grep -oE '^\| `[a-z0-9-]+\.[a-z]+`' | sed -E 's/^\| `(.*)`/\1/'
}

check_tree() {
  local root="$1" hook row failed=0 rows=0 gates
  # shellcheck source=scripts/hooks/lib/registrations.sh
  . "$root/scripts/hooks/lib/registrations.sh"
  gates=$(registered "$root")
  for row in $(rows "$root"); do
    rows=$((rows + 1))
    hook="${row%.*}"
    if [ "${row##*.}" != ts ] || [ ! -f "$root/$HOOKS_SRC/$row" ]; then
      echo "  ✗ docs/reference/REFERENCE.md lists $row, which is not a gate in $HOOKS_SRC/" >&2
      failed=1
    elif ! printf '%s\n' "$gates" | grep -xF "$hook" >/dev/null; then
      echo "  ✗ docs/reference/REFERENCE.md lists $row, which hooks/hooks.json does not register" >&2
      failed=1
    fi
  done
  for hook in $gates; do
    if ! rows "$root" | grep -xF "$hook.ts" >/dev/null; then
      echo "  ✗ hooks/hooks.json registers $hook, which has no $hook.ts row in the docs/reference/REFERENCE.md hook table" >&2
      failed=1
    fi
  done
  if [ "$rows" -eq 0 ]; then
    echo "  ✗ docs/reference/REFERENCE.md has no hook table under ## Hooks" >&2
    failed=1
  fi
  if grep -F "$README_STALE" "$root/scripts/hooks/README.md" >/dev/null \
      || ! grep -F "$README_ROUTER" "$root/scripts/hooks/README.md" >/dev/null; then
    echo "  ✗ scripts/hooks/README.md does not say every hooks/hooks.json command is the router" >&2
    failed=1
  fi
  ROWS=$rows
  return "$failed"
}

self_test() {
  local tmp ok=0
  tmp=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-hooks-doc-fresh-XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  mkdir -p "$tmp/t/docs/reference" "$tmp/t/hooks" "$tmp/t/mcp/trajectory-server/src" "$tmp/t/mcp/trajectory-server/dist"
  cp -R "$REPO_ROOT/scripts" "$tmp/t/scripts"
  cp -R "$REPO_ROOT/$HOOKS_SRC" "$tmp/t/$HOOKS_SRC"
  cp "$REPO_ROOT/mcp/trajectory-server/dist/hooks-router.txt" "$tmp/t/mcp/trajectory-server/dist/"
  cp "$REPO_ROOT/hooks/hooks.json" "$tmp/t/hooks/hooks.json"
  awk '{print} /^\| Hook \| Trigger \| Purpose \|/{getline; print; print "| `deleted-hook.ts` | Stop | gone |"; print "| `git-guards.sh` | PreToolUse Bash | a shell row |"}' \
    "$REPO_ROOT/docs/reference/REFERENCE.md" > "$tmp/t/docs/reference/REFERENCE.md"
  if check_tree "$tmp/t" 2>"$tmp/err" || ! grep -q 'deleted-hook.ts' "$tmp/err" || ! grep -q 'git-guards.sh, which is not a gate' "$tmp/err"; then
    echo "  ✗ self-test: a row for a missing gate or a .sh row should fail naming it" >&2
    ok=1
  fi
  grep -v '^| `orphan-scan.ts` |' "$REPO_ROOT/docs/reference/REFERENCE.md" > "$tmp/t/docs/reference/REFERENCE.md"
  if check_tree "$tmp/t" 2>"$tmp/err2" || ! grep -q 'orphan-scan, which has no orphan-scan.ts row' "$tmp/err2"; then
    echo "  ✗ self-test: a registered hook with no row should fail naming it" >&2
    ok=1
  fi
  cp "$REPO_ROOT/docs/reference/REFERENCE.md" "$tmp/t/docs/reference/REFERENCE.md"
  printf 'Every gate runs through `%s`.\n' "$README_STALE" >> "$tmp/t/scripts/hooks/README.md"
  if check_tree "$tmp/t" 2>"$tmp/err3" || ! grep -q 'scripts/hooks/README.md does not say' "$tmp/err3"; then
    echo "  ✗ self-test: a README naming dispatch.sh should fail" >&2
    ok=1
  fi
  return "$ok"
}

self_test || { echo "Hooks-doc-fresh: FAIL (self-test)" >&2; exit 1; }
ROWS=0
if ! check_tree "${1:-$REPO_ROOT}"; then
  echo "Hooks-doc-fresh: FAIL" >&2
  exit 1
fi
echo "  ✓ self-test: a row for a deleted gate, a .sh row, a registered hook with no row and a README naming dispatch.sh all fail"
echo "  ✓ the $ROWS REFERENCE.md hook rows and the hooks hooks.json registers match, and scripts/hooks/README.md names the router"
echo ""
echo "Hooks-doc-fresh: PASS"
