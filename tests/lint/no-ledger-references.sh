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

# --- Check 2: no bare 'ledger' word in prose files ---
# Whitelists: this script itself, CHANGELOG.md, and ledger_log/ledger_list variants
# (already covered by check 1; excluded here to avoid double-reporting).
BARE_LEDGER_PATHS=(
  "$PLUGIN_ROOT/skills"
  "$PLUGIN_ROOT/agents"
  "$PLUGIN_ROOT/templates/agents"
  "$PLUGIN_ROOT/CLAUDE.md"
  "$PLUGIN_ROOT/mcp/trajectory-server/src"
  "$PLUGIN_ROOT/scripts/hooks"
  "$PLUGIN_ROOT/docs/architecture"
)

LINT_SCRIPT_REL="tests/lint/no-ledger-references.sh"

# Files that legitimately reference the old 'ledger' table name by design:
# db.ts — migration code that reads from the old table and drops it (#170)
# audit-merge.test.ts — tests the ledger→audit migration by building the old schema
# schema.test.ts — asserts the ledger table is absent in a fresh prod DB
BARE_LEDGER_WHITELIST_SUFFIXES=(
  "src/db.ts"
  "src/test/audit-merge.test.ts"
  "src/test/schema.test.ts"
)

for path in "${BARE_LEDGER_PATHS[@]}"; do
  if [ ! -e "$path" ]; then
    continue
  fi
  # grep -Ei '\bledger\b' but exclude lines that only match ledger_log or ledger_list
  # also exclude this lint script itself, CHANGELOG.md, and migration test files
  hits=$(grep -rniE '\bledger\b' "$path" 2>/dev/null \
    | grep -v '\.git' \
    | grep -v "${LINT_SCRIPT_REL}" \
    | grep -v "${PLUGIN_ROOT}/CHANGELOG.md" \
    | grep -vE '\bledger_log\b|\bledger_list\b' \
    || true)
  for suffix in "${BARE_LEDGER_WHITELIST_SUFFIXES[@]}"; do
    hits=$(echo "$hits" | grep -v "${suffix}" || true)
  done
  if [ -n "$hits" ]; then
    echo "FAIL: bare 'ledger' word found (use 'audit' instead):"
    echo "$hits" | head -20
    FAIL=1
  fi
done

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: no bare ledger word found in prose files."
fi

exit "$FAIL"
