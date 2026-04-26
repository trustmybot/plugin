#!/usr/bin/env bash
# L6 flow #95 — Anonymous cold-restart regression
#
# Pre-state: identity row exists with human_name=NULL (Anonymous), config done.
# Trigger: @bro hi (cold session)
# Expected: identity_get returns row with non-null created_at → bro skips
#   onboarding → calls issue_resume → greets the Human in plain
#   second-person. No identity_set, no config_set, no AskUserQuestion.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-anonymous"

l6_run_claude "$PROJECT" "@bro hi" >/dev/null

l6_assert_trajectory "$PROJECT" "$L6_DOGFOOD_DIR/expected/95-anonymous-cold-restart.txt"

# Critical: NO re-onboarding writes should occur.
ROWS_IDENTITY_SET=$(sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "SELECT COUNT(*) FROM debug_trajectory WHERE tool_or_mcp_name LIKE '%identity_set%'")
[ "$ROWS_IDENTITY_SET" = "0" ] || { echo "  ✗ #95 regression: bro called identity_set on cold restart (got $ROWS_IDENTITY_SET)" >&2; exit 1; }

ROWS_CONFIG_SET=$(sqlite3 "$PROJECT/.claude/tmb/trajectory.db" \
  "SELECT COUNT(*) FROM debug_trajectory WHERE tool_or_mcp_name LIKE '%config_set%'")
[ "$ROWS_CONFIG_SET" = "0" ] || { echo "  ✗ #95 regression: bro called config_set on cold restart (got $ROWS_CONFIG_SET)" >&2; exit 1; }

echo "  ✓ #95 regression locked: cold restart with Anonymous skips re-onboarding"
