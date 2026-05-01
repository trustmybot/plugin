#!/usr/bin/env bash
# L5 v2 — 04-agent-creator (FLOWS.md §4)
# Grounded fixture: app.py gives the architect real SQLite/threading code
# so bro has substance to evaluate before spawning the architect agent.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME=$(basename "$HERE")
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT=$(cat "$HERE/prompt.txt")

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

# Copy fixture into the scratch project so the architect prompt has real code
# to evaluate (SQLite + threading = genuine WAL-mode question).
cp "$HERE/fixture/app.py" "$PROJECT/app.py"
(cd "$PROJECT" && git add app.py && git commit -qm "seed app.py for architect review")

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
