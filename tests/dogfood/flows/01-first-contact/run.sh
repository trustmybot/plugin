#!/usr/bin/env bash
# L5 v2 — 01-first-contact (first activation in a fresh project) — see README.md
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="01-first-contact"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro hi"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "empty"
l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
