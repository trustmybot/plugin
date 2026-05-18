#!/usr/bin/env bash
# Regression guard: hook scripts that compare agent/subagent role strings
# must source scripts/hooks/lib/normalize-role.sh first.
#
# Without normalization, CC may deliver "tmb:swe" where the hook expects
# "swe", silently disabling safety gates.
#
# Scans: scripts/hooks/*.sh (not lib/)
#
# Rule: any hook that contains a comparison against a bare role string
#   (= "swe", = "pr-reviewer", != "swe", etc.) MUST also source normalize-role.sh.
#
# --self-test: scan fixtures/bare-role-compare/has-bare-compare.sh and assert exit 1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

ROLE_COMPARE_REGEX='(=|!=)[[:space:]]+"(swe|pr-reviewer|architect|consultant)"'
NORMALIZE_MARKER='(source|\.) +.*normalize-role\.sh'

FAIL=0

run_self_test() {
  local fixture="$HERE/fixtures/bare-role-compare/has-bare-compare.sh"
  if [ ! -f "$fixture" ]; then
    printf 'no-bare-role-compare --self-test: fixture missing: %s\n' "$fixture" >&2
    exit 1
  fi

  local has_compare has_normalize
  has_compare=$(grep -cE "$ROLE_COMPARE_REGEX" "$fixture" || true)
  has_normalize=$(grep -cE "$NORMALIZE_MARKER" "$fixture" || true)

  if [ "$has_compare" -gt 0 ] && [ "$has_normalize" -eq 0 ]; then
    printf 'no-bare-role-compare --self-test: PASS (fixture caught: bare compare without normalize)\n'
    exit 0
  else
    printf 'no-bare-role-compare --self-test: FAIL (fixture not caught as expected)\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

HOOKS_DIR="$PLUGIN_ROOT/scripts/hooks"

while IFS= read -r -d '' hook; do
  rel="${hook#"$PLUGIN_ROOT/"}"

  has_compare=$(grep -cE "$ROLE_COMPARE_REGEX" "$hook" || true)
  [ "$has_compare" -eq 0 ] && continue

  has_normalize=$(grep -cE "$NORMALIZE_MARKER" "$hook" || true)
  if [ "$has_normalize" -eq 0 ]; then
    printf '%s: compares bare role string without sourcing normalize-role.sh\n' "$rel"
    FAIL=1
  fi
done < <(find "$HOOKS_DIR" -maxdepth 1 -name '*.sh' -print0)

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-bare-role-compare: FAIL\n' >&2
  exit 1
fi

printf 'no-bare-role-compare: PASS\n'
