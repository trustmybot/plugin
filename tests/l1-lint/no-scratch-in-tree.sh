#!/usr/bin/env bash
# Lint: the plugin checkout neither tracks nor contains a `.tmp-*` dir at its
# root. Tests keep scratch state under mktemp and remove it; one left at the
# root is a scratch repo a scan could register as a project repo (GH 1551).
#
# Every run first self-tests: a temp root with a planted `.tmp-probe/` must
# fail and the same root without it must pass.
#
# Usage: no-scratch-in-tree.sh [<root>]   check <root> (default: this checkout)

set -uo pipefail

ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# scratch_dirs <root> — each `.tmp-*` dir at <root>'s top level, on disk or
# tracked by git.
scratch_dirs() {
  {
    find "$1" -mindepth 1 -maxdepth 1 -type d -name '.tmp-*' -exec basename {} \;
    if [ -e "$1/.git" ]; then
      git -C "$1" ls-files -- '.tmp-*' 2>/dev/null | cut -d/ -f1
    fi
  } | sort -u
}

TMP=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-no-scratch-XXXXXX")
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/.tmp-probe"
if [ -z "$(scratch_dirs "$TMP")" ]; then
  echo "  ✗ self-test: a root holding .tmp-probe/ should fail" >&2
  exit 1
fi
rmdir "$TMP/.tmp-probe"
if [ -n "$(scratch_dirs "$TMP")" ]; then
  echo "  ✗ self-test: a root with no .tmp-* dir should pass" >&2
  exit 1
fi

found=$(scratch_dirs "$ROOT")
if [ -n "$found" ]; then
  echo "  ✗ scratch dirs at $ROOT (tracked or on disk; tests must clean up after themselves):" >&2
  printf '%s\n' "$found" | sed 's/^/      /' >&2
  exit 1
fi
echo "  ✓ no .tmp-* scratch dir at $ROOT"
