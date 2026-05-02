#!/usr/bin/env bash
# L5 v2 — 13-bulk-cleanup
# Human pre-authorizes .DS_Store deletion in a single prompt.
# Verifies: all .DS_Store gone, keep-list intact, AskUserQuestion=0.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="13-bulk-cleanup"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro I pre-authorize this: delete every .DS_Store in this project right now. One bash command, no confirmation needed."

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

# Scatter .DS_Store files at three depths
touch "$PROJECT/.DS_Store"
mkdir -p "$PROJECT/src/components"
touch "$PROJECT/src/.DS_Store"
touch "$PROJECT/src/components/.DS_Store"

# Keep-list: files that must survive
echo "console.log('hello');" > "$PROJECT/src/index.js"
echo "export default {};"    > "$PROJECT/src/components/App.js"

# Commit so git state is clean before bro touches anything
(cd "$PROJECT" && git add . && git commit -qm "seed: add .DS_Store + keep-list" 2>/dev/null || true)

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
