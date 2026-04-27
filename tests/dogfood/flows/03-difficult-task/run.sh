#!/usr/bin/env bash
# L5 v2 scaffold — see README.md (or fill in scorers/ and remove this notice).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

if [ ! -f "$HERE/outcome.sql" ]; then
  echo "  ⊘ skip: outcome.sql not yet authored for $(basename "$HERE")"
  exit 0
fi

PROMPT=$(cat "$HERE/prompt.txt" 2>/dev/null || echo "")
FIXTURE=$(cat "$HERE/fixture.txt" 2>/dev/null || echo "onboarding-named")

if [ -z "$PROMPT" ]; then
  echo "  ⊘ skip: prompt.txt missing for $(basename "$HERE")"
  exit 0
fi

FLOW_NAME=$(basename "$HERE")
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "$FIXTURE"
l6_run_claude "$PROJECT" "$PROMPT"
l6_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
