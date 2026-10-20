#!/usr/bin/env bash
# tmpdir-cleanup.sh — EXIT-trap removal of a test's scratch directory.
#
# Waits for the test's child processes, then removes the directory with up to
# three attempts a short sleep apart, so a late write (e.g. under a fixture's
# .git) does not fail a run whose assertions all passed. The test keeps its own
# exit status; it fails only when the last attempt still leaves the directory.
#
# Usage:
#   . tests/lib/tmpdir-cleanup.sh
#   TMPDIR=$(_t=${TMPDIR:-/tmp}; mktemp -d "${_t%/}/tmb-<name>.XXXXXX")
#   trap 'tmpdir_cleanup "$TMPDIR"' EXIT

tmpdir_cleanup() {
  local rc=$? dir="$1" attempt
  wait 2>/dev/null || true
  for attempt in 1 2 3; do
    rm -rf "$dir" 2>/dev/null || true
    [ -e "$dir" ] || exit "$rc"
    [ "$attempt" -eq 3 ] || sleep 0.5
  done
  echo "tmpdir_cleanup: could not remove $dir" >&2
  rm -rf "$dir" >&2 || true
  exit 1
}
