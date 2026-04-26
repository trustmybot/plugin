#!/usr/bin/env bash
# L6 flow 01 — First-Run Onboarding (FLOWS.md §1)
#
# Pre-state: empty DB (no identity, no config).
# Trigger: @bro hi
# Expected: identity_get + config_get probes return null → bro invokes
#   tmb_first-run-onboarding skill → AskUserQuestion → identity_set +
#   3x config_set + ledger_log(tmb_onboarding_complete).
#
# NOTE: AskUserQuestion in `claude -p` mode behavior is unverified. If
# the form auto-fails or returns empty in headless mode, this flow's
# trajectory will be SHORTER than expected. That's a real signal — file
# as a follow-up issue.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "empty"

l6_run_claude "$PROJECT" "@bro hi" >/dev/null

l6_assert_trajectory "$PROJECT" "$L6_DOGFOOD_DIR/expected/01-onboarding.txt"
