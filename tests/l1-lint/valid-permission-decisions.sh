#!/usr/bin/env bash
# Lint: PreToolUse hook outputs must use permissionDecision allow|deny|ask.
# CC schema-rejects other values (e.g. legacy "block"); a rejected output
# marks the hook errored, which FAILS OPEN under -p --dangerously-skip-
# permissions — the gate silently stops gating in headless sessions.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BAD=0
while IFS=: read -r file line _content; do
  printf "valid-permission-decisions: %s:%s uses an invalid permissionDecision value\n" "$file" "$line" >&2
  BAD=$((BAD + 1))
done < <(grep -rnE 'permissionDecision[^a-zA-Z]+(block|reject|forbid)' scripts/hooks/*.sh 2>/dev/null || true)

if [ "$BAD" -gt 0 ]; then
  printf "valid-permission-decisions: FAIL (%d)\n" "$BAD"
  exit 1
fi
printf "valid-permission-decisions: PASS\n"
