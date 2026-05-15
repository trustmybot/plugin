#!/usr/bin/env bash
# Verify that file paths referenced in CI workflow YAML actually exist.
# Captures: !2894 BLOCKER — l5-l6-combined.yml referenced a deleted Dockerfile
#           that would have red-flagged every release tag.
#
# Checks: dockerfile:, path:, entry:, script:, and docker build -f references
#         in .github/workflows/*.yml.
#
# --self-test: scan fixtures/ci-workflow-refs/missing-dockerfile.yml and assert exit 1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

FAIL=0

is_local_path() {
  local val="$1"
  # Reject external URLs, bare names, and github action refs
  case "$val" in
    http*|"@"*|*"@"*) return 1 ;;
  esac
  # Must look like a relative local path
  case "$val" in
    tests/*|scripts/*|mcp/*|.github/*|docker/*|*Dockerfile*|*.sh|*.mjs|*.ts|*.yml|*.yaml) return 0 ;;
  esac
  return 1
}

check_workflow() {
  local file="$1"
  local rel="${file#"$PLUGIN_ROOT/"}"
  local lineno=0

  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))

    # Key: value patterns — dockerfile:, entry:, script:
    if printf '%s' "$line" | grep -qE '^\s*(dockerfile|entry|script):\s*\S'; then
      local val
      val="$(printf '%s' "$line" | sed -E 's/^\s*(dockerfile|entry|script):\s*//' | sed "s/#.*//" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      val="$(printf '%s' "$val" | sed "s/^['\"]//; s/['\"]$//")"
      if is_local_path "$val" && [ ! -e "$PLUGIN_ROOT/$val" ]; then
        printf '%s:%d: referenced file does not exist: %s\n' "$rel" "$lineno" "$val"
        FAIL=1
      fi
      continue
    fi

    # Key: value patterns — path: (only when it looks like a local path)
    if printf '%s' "$line" | grep -qE '^\s*path:\s*\S'; then
      local val
      val="$(printf '%s' "$line" | sed -E 's/^\s*path:\s*//' | sed "s/#.*//" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      val="$(printf '%s' "$val" | sed "s/^['\"]//; s/['\"]$//")"
      if is_local_path "$val" && [ ! -e "$PLUGIN_ROOT/$val" ]; then
        printf '%s:%d: referenced path does not exist: %s\n' "$rel" "$lineno" "$val"
        FAIL=1
      fi
      continue
    fi

    # docker build -f <path> pattern
    if printf '%s' "$line" | grep -qE 'docker build.*-f\s+\S'; then
      local val
      val="$(printf '%s' "$line" | grep -oE '\-f\s+[^[:space:]]+' | sed 's/-f[[:space:]]*//')"
      if [ -n "$val" ] && is_local_path "$val" && [ ! -e "$PLUGIN_ROOT/$val" ]; then
        printf '%s:%d: docker build -f references missing file: %s\n' "$rel" "$lineno" "$val"
        FAIL=1
      fi
      continue
    fi

    # run: lines that call local shell scripts directly
    if printf '%s' "$line" | grep -qE '^\s*(bash|sh)\s+(tests|scripts)/[^[:space:]]+\.sh'; then
      local val
      val="$(printf '%s' "$line" | grep -oE '(tests|scripts)/[^[:space:]]+\.sh' | head -1)"
      if [ -n "$val" ] && [ ! -e "$PLUGIN_ROOT/$val" ]; then
        printf '%s:%d: run references missing script: %s\n' "$rel" "$lineno" "$val"
        FAIL=1
      fi
      continue
    fi
  done < "$file"
}

run_self_test() {
  local fixture="$HERE/fixtures/ci-workflow-refs/missing-dockerfile.yml"
  if [ ! -f "$fixture" ]; then
    printf 'ci-workflow-refs-exist --self-test: fixture missing: %s\n' "$fixture" >&2
    exit 1
  fi

  local old_fail=$FAIL
  local old_root=$PLUGIN_ROOT
  FAIL=0
  PLUGIN_ROOT="$HERE/fixtures/ci-workflow-refs"
  check_workflow "$fixture"
  local fixture_fail=$FAIL
  FAIL=$old_fail
  PLUGIN_ROOT=$old_root

  if [ "$fixture_fail" -ne 0 ]; then
    printf 'ci-workflow-refs-exist --self-test: PASS (fixture caught missing reference)\n'
    exit 0
  else
    printf 'ci-workflow-refs-exist --self-test: FAIL (fixture not caught)\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

WORKFLOWS_DIR="$PLUGIN_ROOT/.github/workflows"
if [ ! -d "$WORKFLOWS_DIR" ]; then
  printf 'ci-workflow-refs-exist: PASS (no .github/workflows/ directory)\n'
  exit 0
fi

while IFS= read -r -d '' f; do
  check_workflow "$f"
done < <(find "$WORKFLOWS_DIR" -name '*.yml' -print0)

if [ "$FAIL" -ne 0 ]; then
  printf '\nci-workflow-refs-exist: FAIL\n' >&2
  exit 1
fi

printf 'ci-workflow-refs-exist: PASS\n'
