#!/usr/bin/env bash
# Catch hardcoded developer-machine paths in public-facing artifacts.
# Captures: !2897 — /Users/<name>/, /home/<name>/, /Volumes/, C:\Users\<name>\
#           leaking personal machine paths into the repo.
#
# Scans: README.md, CONTRIBUTING.md, CODEX.md, CURSOR.md, GEMINI.md, CLAUDE.md,
#        SECURITY.md, docs/, tests/manual/, agents/, skills/, commands/, templates/.
#
# Allowlist (excluded): tests/lint/fixtures/, tests/l5-l6/fixtures/,
#                       templates/docs-trustmybot/snapshots/, CHANGELOG.md.
#
# --self-test: scan fixtures/developer-paths/has-personal-path.md and assert exit 1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

DEV_PATH_REGEX='/Users/[A-Za-z][A-Za-z0-9_-]*/|/home/[a-z][a-z0-9_-]*/|/Volumes/[A-Za-z]|C:\\Users\\[A-Za-z]'

ALLOWLIST_PATTERNS=(
  "tests/lint/fixtures/"
  "tests/l5-l6/fixtures/"
  "tests/manual/bench/"
  "templates/docs-trustmybot/snapshots/"
  "CHANGELOG.md"
)

FAIL=0

is_allowlisted() {
  local path="$1"
  local rel="${path#"$PLUGIN_ROOT/"}"
  for pattern in "${ALLOWLIST_PATTERNS[@]}"; do
    case "$rel" in
      "$pattern"*) return 0 ;;
    esac
  done
  return 1
}

scan_path() {
  local path="$1"
  [ -e "$path" ] || return 0

  while IFS=: read -r file lineno _; do
    [ -z "$file" ] || [ -z "$lineno" ] && continue
    is_allowlisted "$file" && continue
    local rel="${file#"$PLUGIN_ROOT/"}"
    printf '%s:%s: hardcoded developer path\n' "$rel" "$lineno"
    FAIL=1
  done < <(grep -rnE "$DEV_PATH_REGEX" "$path" 2>/dev/null || true)
}

run_self_test() {
  local fixture="$HERE/fixtures/developer-paths/has-personal-path.md"
  if [ ! -f "$fixture" ]; then
    printf 'no-developer-paths --self-test: fixture missing: %s\n' "$fixture" >&2
    exit 1
  fi

  local found
  found="$(grep -cE "$DEV_PATH_REGEX" "$fixture" || true)"
  if [ "$found" -gt 0 ]; then
    printf 'no-developer-paths --self-test: PASS (fixture caught %s match(es))\n' "$found"
    exit 0
  else
    printf 'no-developer-paths --self-test: FAIL (fixture not caught)\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

SCAN_TARGETS=(
  README.md
  CONTRIBUTING.md
  CODEX.md
  CURSOR.md
  GEMINI.md
  CLAUDE.md
  SECURITY.md
  docs
  tests/manual
  agents
  skills
  commands
  templates
)

for target in "${SCAN_TARGETS[@]}"; do
  scan_path "$PLUGIN_ROOT/$target"
done

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-developer-paths: FAIL\n' >&2
  exit 1
fi

printf 'no-developer-paths: PASS\n'
