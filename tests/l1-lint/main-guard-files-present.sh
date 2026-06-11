#!/usr/bin/env bash
# Assert that .github/workflows/main-source-guard.yml and .github/CODEOWNERS
# are present in the tree and that the workflow name is exactly 'main source guard'.
#
# Self-test: copies both files to a temp dir, removes them one at a time,
# and verifies this script exits non-zero in each case.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

WORKFLOW="$PLUGIN_ROOT/.github/workflows/main-source-guard.yml"
CODEOWNERS="$PLUGIN_ROOT/.github/CODEOWNERS"

FAIL=0

check_files() {
  local root="$1"
  local wf="$root/.github/workflows/main-source-guard.yml"
  local co="$root/.github/CODEOWNERS"
  local fail=0

  if [ ! -f "$wf" ]; then
    printf 'MISSING: .github/workflows/main-source-guard.yml\n' >&2
    fail=1
  else
    local name_line
    name_line="$(grep -E '^name:' "$wf" | head -1 || true)"
    local name_val
    name_val="$(printf '%s' "$name_line" | sed -E 's/^name:[[:space:]]*//' | sed "s/^['\"]//; s/['\"]$//")"
    if [ "$name_val" != "main source guard" ]; then
      printf 'WRONG workflow name: got "%s", expected "main source guard"\n' "$name_val" >&2
      fail=1
    fi
  fi

  if [ ! -f "$co" ]; then
    printf 'MISSING: .github/CODEOWNERS\n' >&2
    fail=1
  fi

  return "$fail"
}

run_self_test() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  mkdir -p "$tmpdir/.github/workflows"
  cp "$WORKFLOW" "$tmpdir/.github/workflows/main-source-guard.yml"
  cp "$CODEOWNERS" "$tmpdir/.github/CODEOWNERS"

  local self_fail=0

  # Both present — must pass
  if ! check_files "$tmpdir"; then
    printf 'self-test FAIL: both-present case should pass\n' >&2
    self_fail=1
  fi

  # Remove workflow — must fail
  rm "$tmpdir/.github/workflows/main-source-guard.yml"
  if check_files "$tmpdir" 2>/dev/null; then
    printf 'self-test FAIL: missing workflow not detected\n' >&2
    self_fail=1
  fi

  # Restore workflow, remove CODEOWNERS — must fail
  cp "$WORKFLOW" "$tmpdir/.github/workflows/main-source-guard.yml"
  rm "$tmpdir/.github/CODEOWNERS"
  if check_files "$tmpdir" 2>/dev/null; then
    printf 'self-test FAIL: missing CODEOWNERS not detected\n' >&2
    self_fail=1
  fi

  # Wrong name — must fail
  cp "$CODEOWNERS" "$tmpdir/.github/CODEOWNERS"
  sed 's/^name:.*/name: wrong name/' "$WORKFLOW" > "$tmpdir/.github/workflows/main-source-guard.yml"
  if check_files "$tmpdir" 2>/dev/null; then
    printf 'self-test FAIL: wrong workflow name not detected\n' >&2
    self_fail=1
  fi

  if [ "$self_fail" -eq 0 ]; then
    printf 'main-guard-files-present --self-test: PASS\n'
    exit 0
  else
    printf 'main-guard-files-present --self-test: FAIL\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

if ! check_files "$PLUGIN_ROOT"; then
  FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  printf 'main-guard-files-present: FAIL\n' >&2
  exit 1
fi

printf 'main-guard-files-present: PASS\n'
