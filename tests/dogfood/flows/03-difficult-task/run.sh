#!/usr/bin/env bash
# L5 v2 — 03-difficult-task (FLOWS.md §3)
# Architecture-touching follow-up to 02's todo CLI: triggers tmb_planning.
# Seeds todo.py so bro has existing code to evaluate — mirrors the narrative
# that "02 already shipped the CLI; now we're adding a sync API".

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="03-difficult-task"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro add a sync API to that python todo CLI — design the storage architecture first since it touches multiple modules and changes the public surface"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

# Seed todo.py so bro has existing code to analyse.
cp "$HERE/fixture/todo.py" "$PROJECT/todo.py"
(cd "$PROJECT" && git add todo.py && git commit -qm "feat: initial todo CLI")

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
