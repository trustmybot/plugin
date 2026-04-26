#!/usr/bin/env bash
# L6 v2 — 95-anonymous-cold-restart (regression for #95) — see README.md
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="95-anonymous-cold-restart"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro hi"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-anonymous"
l6_run_claude "$PROJECT" "$PROMPT" >/dev/null
l6_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
