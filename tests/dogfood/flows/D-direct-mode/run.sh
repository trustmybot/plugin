#!/usr/bin/env bash
# L6 v2 — D-direct-mode (FLOWS.md §D) — see README.md
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="D-direct-mode"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro fix the typo 'recieve' to 'receive' in README.md"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

# Plant the typo so bro has something to fix.
( cd "$PROJECT" && echo "We recieve patches via PRs." > README.md
  git add . && git commit -qm "chore: add typo'd line" )

l6_run_claude "$PROJECT" "$PROMPT"
l6_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
