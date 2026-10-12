#!/usr/bin/env bash
# Lint: every hook row in the docs/reference/REFERENCE.md hook table names a
# script that exists under scripts/hooks/ and is registered in hooks/hooks.json
# (`dispatch.sh <name>`), so a deleted or unwired hook cannot leave a stale row.
#
# Usage: hooks-doc-fresh.sh [<root>]   (default: this repo; self-tests first)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

check_tree() {
  local root="$1" hook failed=0 rows=0
  for hook in $(awk '/^## Hooks/{on=1; next} on && /^## /{on=0} on' "$root/docs/reference/REFERENCE.md" \
      | grep -oE '^\| `[a-z0-9-]+\.sh`' | sed -E 's/^\| `(.*)\.sh`/\1/'); do
    rows=$((rows + 1))
    if [ ! -f "$root/scripts/hooks/$hook.sh" ]; then
      echo "  ✗ docs/reference/REFERENCE.md lists $hook.sh, which is not in scripts/hooks/" >&2
      failed=1
    elif ! grep -qF "dispatch.sh $hook\"" "$root/hooks/hooks.json"; then
      echo "  ✗ docs/reference/REFERENCE.md lists $hook.sh, which hooks/hooks.json does not register" >&2
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
  return "$ok"
}

self_test || { echo "Hooks-doc-fresh: FAIL (self-test)" >&2; exit 1; }
ROWS=0
if ! check_tree "${1:-$REPO_ROOT}"; then
  echo "Hooks-doc-fresh: FAIL" >&2
  exit 1
fi
echo "  ✓ self-test: a row for a deleted hook fails"
echo "  ✓ all $ROWS REFERENCE.md hook rows exist in scripts/hooks/ and are registered in hooks/hooks.json"
echo ""
echo "Hooks-doc-fresh: PASS"
