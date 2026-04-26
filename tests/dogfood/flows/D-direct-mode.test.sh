#!/usr/bin/env bash
# L6 flow D — Direct Mode (FLOWS.md §D)
#
# Pre-state: onboarding complete + a README.md to typo-fix.
# Trigger: @bro fix typo "recieve" → "receive" in README.md
# Expected: bro detects ≤3-line single-file scope → Direct Mode →
#   Edit + git commit + ledger_log(direct_mode_used). NO task_create_batch,
#   NO Task spawn.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

# Plant the typo so bro has something to fix.
( cd "$PROJECT" && echo "We recieve patches via PRs." > README.md
  git add . && git commit -qm "chore: add typo'd line" )

l6_run_claude "$PROJECT" "@bro fix the typo 'recieve' to 'receive' in README.md" >/dev/null

l6_assert_trajectory "$PROJECT" "$L6_DOGFOOD_DIR/expected/D-direct-mode.txt"

# Additional invariants for Direct Mode (ENUMS.md):
ROWS_TASK_BATCH=$(sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "SELECT COUNT(*) FROM debug_trajectory WHERE tool_or_mcp_name LIKE '%task_create_batch%'")
[ "$ROWS_TASK_BATCH" = "0" ] || { echo "  ✗ Direct Mode must NOT call task_create_batch (got $ROWS_TASK_BATCH)" >&2; exit 1; }

ROWS_TASK_SPAWN=$(sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "SELECT COUNT(*) FROM debug_trajectory WHERE tool_or_mcp_name = 'Task'")
[ "$ROWS_TASK_SPAWN" = "0" ] || { echo "  ✗ Direct Mode must NOT spawn SWE via Task (got $ROWS_TASK_SPAWN)" >&2; exit 1; }

EVENT_DIRECT=$(sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "SELECT COUNT(*) FROM ledger WHERE event_type = 'direct_mode_used'")
[ "$EVENT_DIRECT" = "1" ] || { echo "  ✗ Direct Mode must log exactly one direct_mode_used event (got $EVENT_DIRECT)" >&2; exit 1; }

echo "  ✓ Direct Mode invariants verified: no task_create_batch, no Task spawn, one direct_mode_used"
