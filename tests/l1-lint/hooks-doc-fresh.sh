#!/usr/bin/env bash
# Lint: the docs/reference/REFERENCE.md hook table and hooks/hooks.json agree
# both ways. Every row names a script that exists under scripts/hooks/ and is
# registered in hooks.json (a gate dist/hooks-router.txt lists for a router
# entry's event; the lint also reads `dispatch.sh <name>` and the gates of a
# chain, scripts/hooks/lib/registrations.sh), so a deleted or unwired
# hook cannot leave a stale row; every hook hooks.json registers has a row.
# A gate born in TypeScript (no .sh) has a `<name>.ts` row naming its
# mcp/trajectory-server/src/hooks/<name>.ts source; a ported gate may too.
# scripts/hooks/README.md opens its entry-point section with the router as every
# registration, not dispatch.sh (GH 1692).
#
# Usage: hooks-doc-fresh.sh [<root>]   (default: this repo; self-tests first)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
README_ROUTER='Every `hooks/hooks.json` command is the TypeScript router, `node dist/hooks.js <Event> [part]`'
README_STALE='Every `hooks/hooks.json` command on SessionStart, UserPromptSubmit and WorktreeCreate is `"${CLAUDE_PLUGIN_ROOT}/scripts/hooks/dispatch.sh"'

# registered <root> — every gate script hooks.json runs, chains and the
# router entry (its dist/hooks-router.txt gates) expanded.
registered() {
  local name members
  {
    for name in $(grep -oE 'dispatch\.sh(\\")? [a-z0-9-]+"' "$1/hooks/hooks.json" | sed -E 's/dispatch\.sh(\\")? (.*)"/\2/' | sort -u); do
      members=$(tmb_chain_table "$name" | cut -d' ' -f1)
      printf '%s\n' ${members:-$name}
    done
    for name in $(grep -oE 'dist/hooks\.js\\" [A-Za-z]+' "$1/hooks/hooks.json" | sed -E 's/.* //' | sort -u); do
      tmb_router_gates "$1" "$name"
    done
    grep -oE 'dist/hooks\.js\\" liveness-sentinel"' "$1/hooks/hooks.json" | sed -E 's/.* (.*)"/\1/'
  } | sort -u
}

check_tree() {
  local root="$1" hook row dir failed=0 rows=0 gates
  # shellcheck source=scripts/hooks/lib/registrations.sh
  . "$root/scripts/hooks/lib/registrations.sh"
  gates=$(registered "$root")
  for row in $(awk '/^## Hooks/{on=1; next} on && /^## /{on=0} on' "$root/docs/reference/REFERENCE.md" \
      | grep -oE '^\| `[a-z0-9-]+\.(sh|ts)`' | sed -E 's/^\| `(.*)`/\1/'); do
    rows=$((rows + 1))
    hook="${row%.*}"
    if [ "${row##*.}" = ts ]; then dir="mcp/trajectory-server/src/hooks"; else dir="scripts/hooks"; fi
    if [ ! -f "$root/$dir/$row" ]; then
      echo "  ✗ docs/reference/REFERENCE.md lists $row, which is not in $dir/" >&2
      failed=1
    elif ! printf '%s\n' "$gates" | grep -xF "$hook" >/dev/null; then
      echo "  ✗ docs/reference/REFERENCE.md lists $row, which hooks/hooks.json does not register" >&2
      failed=1
    fi
  done
  for hook in $gates; do
    row="$hook.sh"
    [ -f "$root/scripts/hooks/$row" ] || [ ! -f "$root/mcp/trajectory-server/src/hooks/$hook.ts" ] || row="$hook.ts"
    if ! awk '/^## Hooks/{on=1; next} on && /^## /{on=0} on' "$root/docs/reference/REFERENCE.md" | grep -F -e "| \`$row\` |" -e "| \`$hook.ts\` |" >/dev/null; then
      echo "  ✗ hooks/hooks.json registers $row, which has no row in the docs/reference/REFERENCE.md hook table" >&2
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
  mkdir -p "$tmp/t/docs/reference" "$tmp/t/hooks" "$tmp/t/mcp/trajectory-server/src"
  cp -R "$REPO_ROOT/scripts" "$tmp/t/scripts"
  cp -R "$REPO_ROOT/mcp/trajectory-server/src/hooks" "$tmp/t/mcp/trajectory-server/src/hooks"
  mkdir -p "$tmp/t/mcp/trajectory-server/dist"
  cp "$REPO_ROOT/mcp/trajectory-server/dist/hooks-router.txt" "$tmp/t/mcp/trajectory-server/dist/"
  cp "$REPO_ROOT/hooks/hooks.json" "$tmp/t/hooks/hooks.json"
  awk '{print} /^\| Hook \| Trigger \| Purpose \|/{getline; print; print "| `deleted-hook.sh` | Stop | gone |"}' \
    "$REPO_ROOT/docs/reference/REFERENCE.md" > "$tmp/t/docs/reference/REFERENCE.md"
  if check_tree "$tmp/t" 2>"$tmp/err" || ! grep -q 'deleted-hook.sh' "$tmp/err"; then
    echo "  ✗ self-test: a row for a missing hook should fail naming it" >&2
    ok=1
  fi
  grep -v '^| `orphan-scan.sh` |' "$REPO_ROOT/docs/reference/REFERENCE.md" > "$tmp/t/docs/reference/REFERENCE.md"
  if check_tree "$tmp/t" 2>"$tmp/err2" || ! grep -q 'orphan-scan.sh, which has no row' "$tmp/err2"; then
    echo "  ✗ self-test: a registered hook with no row should fail naming it" >&2
    ok=1
  fi
  cp "$REPO_ROOT/docs/reference/REFERENCE.md" "$tmp/t/docs/reference/REFERENCE.md"
  printf '%s\n' "$README_STALE" >> "$tmp/t/scripts/hooks/README.md"
  if check_tree "$tmp/t" 2>"$tmp/err3" || ! grep -q 'scripts/hooks/README.md does not say' "$tmp/err3"; then
    echo "  ✗ self-test: a README naming dispatch.sh as the registered command should fail" >&2
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
echo "  ✓ self-test: a row for a deleted hook, a registered hook with no row and a stale README sentence all fail"
echo "  ✓ the $ROWS REFERENCE.md hook rows and the hooks hooks.json registers match, and scripts/hooks/README.md names the router"
echo ""
echo "Hooks-doc-fresh: PASS"
