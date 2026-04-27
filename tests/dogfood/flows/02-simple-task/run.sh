#!/usr/bin/env bash
# L5 v2 — 02-simple-task (FLOWS.md §2)
# Industry-standard multi-scorer: outcome + trajectory_required +
# trajectory_forbidden + cost. See README.md in this directory.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="02-simple-task"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro write a python cli todo"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"
l6_run_claude "$PROJECT" "$PROMPT"
l6_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
