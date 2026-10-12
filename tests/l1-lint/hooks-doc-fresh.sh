#!/usr/bin/env bash
# Lint: the docs/reference/REFERENCE.md hook table and hooks/hooks.json agree
# both ways. Every row names a script that exists under scripts/hooks/ and is
# registered in hooks.json (`dispatch.sh <name>`, or as a gate of a chain
# registration, scripts/hooks/lib/registrations.sh), so a deleted or unwired
# hook cannot leave a stale row; every hook hooks.json registers has a row.
#
# Usage: hooks-doc-fresh.sh [<root>]   (default: this repo; self-tests first)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

# registered <root> — every gate script hooks.json runs, chains expanded.
registered() {
  local name members
  for name in $(grep -oE 'dispatch\.sh(\\")? [a-z0-9-]+"' "$1/hooks/hooks.json" | sed -E 's/dispatch\.sh(\\")? (.*)"/\2/' | sort -u); do
    members=$(tmb_chain_table "$name" | cut -d' ' -f1)
    printf '%s\n' ${members:-$name}
  done | sort -u
}

check_tree() {
  local root="$1" hook failed=0 rows=0 gates
  # shellcheck source=scripts/hooks/lib/registrations.sh
  . "$root/scripts/hooks/lib/registrations.sh"
  gates=$(registered "$root")
  for hook in $(awk '/^## Hooks/{on=1; next} on && /^## /{on=0} on' "$root/docs/reference/REFERENCE.md" \
      | grep -oE '^\| `[a-z0-9-]+\.sh`' | sed -E 's/^\| `(.*)\.sh`/\1/'); do
    rows=$((rows + 1))
    if [ ! -f "$root/scripts/hooks/$hook.sh" ]; then
      echo "  ✗ docs/reference/REFERENCE.md lists $hook.sh, which is not in scripts/hooks/" >&2
      failed=1
    elif ! printf '%s\n' "$gates" | grep -xF "$hook" >/dev/null; then
      echo "  ✗ docs/reference/REFERENCE.md lists $hook.sh, which hooks/hooks.json does not register" >&2
      failed=1
    fi
  done
  for hook in $gates; do
    if ! awk '/^## Hooks/{on=1; next} on && /^## /{on=0} on' "$root/docs/reference/REFERENCE.md" | grep -F "| \`$hook.sh\` |" >/dev/null; then
      echo "  ✗ hooks/hooks.json registers $hook.sh, which has no row in the docs/reference/REFERENCE.md hook table" >&2
      failed=1
    fi
  done
  if [ "$rows" -eq 0 ]; then
    echo "  ✗ docs/reference/REFERENCE.md has no hook table under ## Hooks" >&2
    failed=1
  fi
  ROWS=$rows
  return "$failed"
}

self_test() {
  local tmp ok=0
  tmp=$(mktemp -d -t tmb-hooks-doc-fresh-XXXX)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  mkdir -p "$tmp/t/docs/reference" "$tmp/t/hooks"
  cp -R "$REPO_ROOT/scripts" "$tmp/t/scripts"
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
  return "$ok"
}

self_test || { echo "Hooks-doc-fresh: FAIL (self-test)" >&2; exit 1; }
ROWS=0
if ! check_tree "${1:-$REPO_ROOT}"; then
  echo "Hooks-doc-fresh: FAIL" >&2
  exit 1
fi
echo "  ✓ self-test: a row for a deleted hook and a registered hook with no row both fail"
echo "  ✓ the $ROWS REFERENCE.md hook rows and the hooks hooks.json registers match"
echo ""
echo "Hooks-doc-fresh: PASS"
