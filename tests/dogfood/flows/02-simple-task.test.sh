#!/usr/bin/env bash
# L6 flow 02 — Simple Task (FLOWS.md §2)
#
# Pre-state: onboarding complete (named identity).
# Trigger: @bro write a python cli todo
# Expected: bro detects code-touching ask → triages simple → creates
#   issue + task → spawns SWE → batches ledger_log(planning_complete).
#   Spec body assertion is out of scope here (covered by L4).

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

l6_run_claude "$PROJECT" "@bro write a python cli todo" >/dev/null

l6_assert_trajectory "$PROJECT" "$L6_DOGFOOD_DIR/expected/02-simple-task.txt"
