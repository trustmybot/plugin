#!/usr/bin/env bash
# L5 v2 — 95-anonymous-cold-restart (regression for #95) — see README.md
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="95-anonymous-cold-restart"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro hi"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-anonymous"
l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
