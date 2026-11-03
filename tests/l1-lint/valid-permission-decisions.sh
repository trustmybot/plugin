#!/usr/bin/env bash
# Lint: PreToolUse hook outputs must use permissionDecision allow|deny|ask.
# CC schema-rejects other values (e.g. legacy "block"); a rejected output
# marks the hook errored, which FAILS OPEN under -p --dangerously-skip-
# permissions — the gate silently stops gating in non-interactive sessions.
# Judges the TypeScript gates, mcp/trajectory-server/src/hooks/**/*.ts.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

HOOKS_SRC="mcp/trajectory-server/src/hooks"
GATE_SOURCES="$(find "$HOOKS_SRC" -name '*.ts' -type f 2>/dev/null || true)"
if [ -z "$GATE_SOURCES" ]; then
  printf "valid-permission-decisions: FAIL (no gate sources under %s)\n" "$HOOKS_SRC" >&2
  exit 1
fi

BAD=0
while IFS=: read -r file line _content; do
  printf "valid-permission-decisions: %s:%s uses an invalid permissionDecision value\n" "$file" "$line" >&2
  BAD=$((BAD + 1))
done < <(grep -rnE --include='*.ts' 'permissionDecision[^a-zA-Z]+(block|reject|forbid)' "$HOOKS_SRC" 2>/dev/null || true)

if [ "$BAD" -gt 0 ]; then
  printf "valid-permission-decisions: FAIL (%d)\n" "$BAD"
  exit 1
fi
printf "valid-permission-decisions: PASS\n"
