#!/usr/bin/env bash
# Catch audit_log() calls that still pass the dropped kind= argument.
# Captures: !2892 MINOR + !2893 — kind was removed from the schema in rc.2;
#           calls passing it are silently ignored but mislead readers.
#
# Scans: docs/, skills/, agents/, commands/, templates/agents/, top-level *.md.
#
# --self-test: scan fixtures/audit-log-kind/has-kind.md and assert exit 1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

KIND_REGEX='audit_log[^)]*kind\s*='

FAIL=0

scan_path() {
  local path="$1"
  [ -e "$path" ] || return 0
  while IFS=: read -r file lineno _; do
    [ -z "$lineno" ] && continue
    local rel="${file#"$PLUGIN_ROOT/"}"
    printf '%s:%s: audit_log() with deprecated kind= arg\n' "$rel" "$lineno"
    FAIL=1
  done < <(grep -rnE "$KIND_REGEX" "$path" || true)
}

run_self_test() {
  local fixture="$HERE/fixtures/audit-log-kind/has-kind.md"
  if [ ! -f "$fixture" ]; then
    printf 'no-audit-log-kind --self-test: fixture missing: %s\n' "$fixture" >&2
    exit 1
  fi

  local found
  found="$(grep -cE "$KIND_REGEX" "$fixture" || true)"
  if [ "$found" -gt 0 ]; then
    printf 'no-audit-log-kind --self-test: PASS (fixture caught %s match(es))\n' "$found"
    exit 0
  else
    printf 'no-audit-log-kind --self-test: FAIL (fixture not caught)\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

for target in docs skills agents commands templates/agents CLAUDE.md CODEX.md CURSOR.md GEMINI.md; do
  scan_path "$PLUGIN_ROOT/$target"
done

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-audit-log-kind: FAIL\n' >&2
  exit 1
fi

printf 'no-audit-log-kind: PASS\n'
