#!/usr/bin/env bash
# Lint: the MCP tool documentation lists what mcp/trajectory-server/src/tools/index.ts
# registers. Every tool module index.ts imports is a row of the tool-family
# table in mcp/trajectory-server/README.md (`tools/<module>.ts`) and of
# src/tools/README.md (`<module>.ts`); every tool those modules define (a
# `name: '<tool>'` definition) is named in src/tools/README.md and in the
# "MCP tools (full list)" section of docs/reference/REFERENCE.md, whose
# "<N> tools" count matches.
#
# Usage: tool-families-documented.sh [<root>]   (default: this repo)
#        tool-families-documented.sh --self-test

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

check_tree() {
  local root="$1"
  local tools="$root/mcp/trajectory-server/src/tools"
  local readme="$root/mcp/trajectory-server/README.md" tools_readme="$tools/README.md"
  local reference="$root/docs/reference/REFERENCE.md"
  local failed=0 module tool total=0 ref_section stated
  ref_section=$(awk '/^## MCP tools/{on=1; print; next} on && /^## /{on=0} on' "$reference")
  for module in $(grep -oE "from '\./[a-z_-]+\.js'" "$tools/index.ts" | sed -E "s/from '\.\/(.*)\.js'/\1/"); do
    grep -qF "\`tools/$module.ts\`" "$readme" || { echo "  ✗ mcp/trajectory-server/README.md tool-family table has no row for tools/$module.ts" >&2; failed=1; }
    grep -qF "\`$module.ts\`" "$tools_readme" || { echo "  ✗ src/tools/README.md has no row for $module.ts" >&2; failed=1; }
    for tool in $(grep -oE "^[[:space:]]+name: '[a-z_]+'" "$tools/$module.ts" | sed -E "s/.*'(.*)'/\1/"); do
      total=$((total + 1))
      grep -qF "\`$tool\`" "$tools_readme" || { echo "  ✗ src/tools/README.md does not name $tool ($module.ts)" >&2; failed=1; }
      printf '%s\n' "$ref_section" | grep -F "\`$tool\`" >/dev/null || { echo "  ✗ docs/reference/REFERENCE.md MCP tools list does not name $tool ($module.ts)" >&2; failed=1; }
    done
  done
  stated=$(printf '%s\n' "$ref_section" | grep -oE '^[0-9]+ tools' | head -1 | cut -d' ' -f1)
  if [ "$stated" != "$total" ]; then
    echo "  ✗ docs/reference/REFERENCE.md says '${stated:-?} tools'; index.ts registers $total" >&2
    failed=1
  fi
  TOTAL=$total
  return "$failed"
}

self_test() {
  local tmp ok=0
  tmp=$(mktemp -d "$(printf %s "${TMPDIR:-/tmp}" | sed 's|/*$||')/tmb-tool-families-XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  mkdir -p "$tmp/t/mcp/trajectory-server/src/tools" "$tmp/t/docs/reference"
  cp "$REPO_ROOT/mcp/trajectory-server/src/tools/index.ts" "$REPO_ROOT/mcp/trajectory-server/src/tools/"*.ts "$tmp/t/mcp/trajectory-server/src/tools/"
  cp "$REPO_ROOT/mcp/trajectory-server/src/tools/README.md" "$tmp/t/mcp/trajectory-server/src/tools/README.md"
  cp "$REPO_ROOT/mcp/trajectory-server/README.md" "$tmp/t/mcp/trajectory-server/README.md"
  cp "$REPO_ROOT/docs/reference/REFERENCE.md" "$tmp/t/docs/reference/REFERENCE.md"
  sed -i.bak '/^| Stats | `tools\/stats.ts`/d' "$tmp/t/mcp/trajectory-server/README.md"
  sed -i.bak 's/`trajectory_doctor`//' "$tmp/t/docs/reference/REFERENCE.md"
  if check_tree "$tmp/t" 2>"$tmp/err"; then
    echo "  ✗ self-test: a missing family row and a missing tool should fail" >&2; ok=1
  elif ! grep -q 'tools/stats.ts' "$tmp/err" || ! grep -q 'trajectory_doctor' "$tmp/err"; then
    echo "  ✗ self-test: failure did not name tools/stats.ts and trajectory_doctor:" >&2; cat "$tmp/err" >&2; ok=1
  fi
  return "$ok"
}

if [ "${1:-}" = --self-test ]; then
  self_test || { echo "Tool-families-documented: FAIL (self-test)" >&2; exit 1; }
  echo "  ✓ self-test: a missing family row and a missing tool both fail"
  exit 0
fi

self_test || { echo "Tool-families-documented: FAIL (self-test)" >&2; exit 1; }
TOTAL=0
if ! check_tree "${1:-$REPO_ROOT}"; then
  echo "Tool-families-documented: FAIL" >&2
  exit 1
fi
echo "  ✓ self-test: a missing family row and a missing tool both fail"
echo "  ✓ README, src/tools/README.md and REFERENCE.md list every family and all $TOTAL tools in tools/index.ts"
echo ""
echo "Tool-families-documented: PASS"
