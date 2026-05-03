#!/usr/bin/env bash
# L1 lint: no ledger_log or ledger_list references in plugin source.
# These tools were removed in #170 (merged into audit_log/audit_log_list).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

SCAN_PATHS=(
  "$PLUGIN_ROOT/skills"
  "$PLUGIN_ROOT/agents"
  "$PLUGIN_ROOT/templates/agents"
  "$PLUGIN_ROOT/CLAUDE.md"
  "$PLUGIN_ROOT/mcp/trajectory-server/src"
  "$PLUGIN_ROOT/scripts/hooks"
  "$PLUGIN_ROOT/docs/architecture"
)

FAIL=0

for path in "${SCAN_PATHS[@]}"; do
  if [ ! -e "$path" ]; then
    continue
  fi
  if grep -rl 'ledger_log\b\|ledger_list\b' "$path" 2>/dev/null | grep -v '\.git' | head -5 | grep -q .; then
    echo "FAIL: ledger_log/ledger_list references found in: $path"
    grep -rn 'ledger_log\b\|ledger_list\b' "$path" 2>/dev/null | grep -v '\.git' | head -20
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: no ledger_log/ledger_list references found in plugin source."
fi

exit "$FAIL"
