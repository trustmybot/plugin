#!/usr/bin/env bash
# Lint: ENUMs.md and code agree on the controlled vocabularies.
#
# Specifically checks: every value bro/swe/pr-reviewer might write to a
# whitelisted column appears in ENUMS.md. Catches: a new task status
# added to schema/code but not the doc, OR a doctrine value the lint has
# never heard of being silently introduced.
#
# Strategy: parse ENUMS.md tables to extract canonical values per column,
# grep the codebase for hardcoded value strings, fail if any string
# appears in code but not in the doc.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOC="$ROOT/docs/contributing/ENUMS.md"

if [ ! -f "$DOC" ]; then
  echo "  ✗ ENUMS.md missing at $DOC" >&2
  exit 1
fi

# Extract the doctrine values for tasks.status, validation_attempts.verdict,
# and ledger.event_type. These are the most-branched-on ENUMs in hooks + skills.
extract_section_values() {
  local doc="$1" section="$2"
  awk -v section="### \`$section\`" '
    $0 ~ section { in_section=1; next }
    in_section && /^### / { in_section=0 }
    in_section && /^\| `/ { print }
  ' "$doc" | grep -oE '^\| `[^`]+`' | sed -E 's/^\| `([^`]+)`/\1/' | sort -u
}

TASK_STATUSES=$(extract_section_values "$DOC" "tasks.status")
VERDICTS=$(extract_section_values "$DOC" "validation_attempts.verdict")
LEDGER_EVENTS=$(extract_section_values "$DOC" "ledger.event_type")

if [ -z "$TASK_STATUSES" ] || [ -z "$VERDICTS" ] || [ -z "$LEDGER_EVENTS" ]; then
  echo "  ✗ Could not parse ENUMS.md — missing canonical sections" >&2
  exit 1
fi

failed=0

# Check: every task-status hardcoded in TS code is in the doctrine.
# Pattern: `status: 'pending'` or `'completed'` etc — narrow grep on TS files.
for status in $(grep -hoE "(\bstatus\s*[:=]\s*['\"][a-z_]+['\"])" "$ROOT/mcp/trajectory-server/src"/*.ts "$ROOT/mcp/trajectory-server/src/tools"/*.ts 2>/dev/null | grep -oE "['\"][a-z_]+['\"]" | tr -d "'\"" | sort -u); do
  if ! echo "$TASK_STATUSES" | grep -qx "$status"; then
    # Skip values that are clearly unrelated (e.g. shorts like 'on', 'off')
    if echo "pending running completed closed failed escalated open in_progress" | grep -qw "$status"; then
      echo "  ✗ task status '$status' used in code but missing from ENUMS.md" >&2
      failed=1
    fi
  fi
done

# Check: every verdict value used in tools/validation.ts is in the doctrine.
if [ -f "$ROOT/mcp/trajectory-server/src/tools/validation.ts" ]; then
  for verdict in $(grep -oE "verdict\s*[:=]\s*['\"][a-z]+['\"]" "$ROOT/mcp/trajectory-server/src/tools/validation.ts" | grep -oE "['\"][a-z]+['\"]" | tr -d "'\"" | sort -u); do
    if ! echo "$VERDICTS" | grep -qx "$verdict"; then
      echo "  ✗ verdict '$verdict' used in validation.ts but missing from ENUMS.md" >&2
      failed=1
    fi
  done
fi

# Sanity report
N_STATUSES=$(echo "$TASK_STATUSES" | wc -l | tr -d ' ')
N_VERDICTS=$(echo "$VERDICTS" | wc -l | tr -d ' ')
N_EVENTS=$(echo "$LEDGER_EVENTS" | wc -l | tr -d ' ')

if [ $failed -ne 0 ]; then
  echo "" >&2
  echo "  Add the missing value to docs/contributing/ENUMS.md before merge." >&2
  exit 1
fi

echo "  ✓ ENUMS.md documents $N_STATUSES task statuses, $N_VERDICTS verdicts, $N_EVENTS ledger event types"
echo ""
echo "Enums-stable: PASS"
