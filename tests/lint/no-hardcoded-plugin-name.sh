#!/usr/bin/env bash
# Catch hardcoded plugin-name strings outside the resolve-plugin-name helper.
# Captures: !2896 channel-iso — .claude/tmb/, tmb-active-workspace,
#           trustmybot-rc, ="tmb"/"tmb" in path-construction code.
#
# Scans: scripts/, mcp/trajectory-server/src/
#
# Exclusions:
#   - scripts/lib/resolve-plugin-name.sh (the helper itself)
#   - Lines containing: jq -r '.name // "tmb"' (inline fallback pattern)
#   - scripts/hooks/lib/query-task.sh (walk-up default)
#   - *test* files
#
# --self-test: scan fixtures/hardcoded-plugin-name/has-hardcoded.sh and assert exit 1.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

HARDCODED_REGEX='(\.claude/tmb/|tmb-active-workspace|trustmybot-rc|=["\x27]tmb["\x27])'

EXCLUDED_FILES=(
  "scripts/lib/resolve-plugin-name.sh"
  "scripts/hooks/lib/query-task.sh"
)

EXCLUDED_LINE_PATTERNS=(
  "jq -r '.name // \"tmb\"'"
  'jq -r .name'
  'PLUGIN_NAME="tmb"'
  "PLUGIN_NAME='tmb'"
)

FAIL=0

is_excluded_file() {
  local rel="$1"
  for excl in "${EXCLUDED_FILES[@]}"; do
    [ "$rel" = "$excl" ] && return 0
  done
  case "$rel" in
    *test*) return 0 ;;
  esac
  return 1
}

is_excluded_line() {
  local line="$1"
  for pattern in "${EXCLUDED_LINE_PATTERNS[@]}"; do
    if printf '%s' "$line" | grep -qF "$pattern"; then
      return 0
    fi
  done
  return 1
}

scan_dir() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  while IFS= read -r -d '' f; do
    local rel="${f#"$PLUGIN_ROOT/"}"
    is_excluded_file "$rel" && continue
    while IFS=: read -r lineno content; do
      [ -z "$lineno" ] && continue
      is_excluded_line "$content" && continue
      printf '%s:%s: hardcoded plugin name\n' "$rel" "$lineno"
      FAIL=1
    done < <(grep -nE "$HARDCODED_REGEX" "$f" || true)
  done < <(find "$dir" -type f \( -name '*.sh' -o -name '*.ts' -o -name '*.js' \) -print0)
}

run_self_test() {
  local fixture="$HERE/fixtures/hardcoded-plugin-name/has-hardcoded.sh"
  if [ ! -f "$fixture" ]; then
    printf 'no-hardcoded-plugin-name --self-test: fixture missing: %s\n' "$fixture" >&2
    exit 1
  fi

  local found
  found="$(grep -cE "$HARDCODED_REGEX" "$fixture" || true)"
  if [ "$found" -gt 0 ]; then
    printf 'no-hardcoded-plugin-name --self-test: PASS (fixture caught %s match(es))\n' "$found"
    exit 0
  else
    printf 'no-hardcoded-plugin-name --self-test: FAIL (fixture not caught)\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
fi

scan_dir "$PLUGIN_ROOT/scripts"
scan_dir "$PLUGIN_ROOT/mcp/trajectory-server/src"

if [ "$FAIL" -ne 0 ]; then
  printf '\nno-hardcoded-plugin-name: FAIL\n' >&2
  exit 1
fi

printf 'no-hardcoded-plugin-name: PASS\n'
