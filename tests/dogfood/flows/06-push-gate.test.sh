#!/usr/bin/env bash
# L6 flow 06-push-gate — FLOWS.md §6 — Push gate / PR review
#
# SCAFFOLD — fill in the expected-trajectory file before enabling.
# Until then this test is a no-op skip.
#
# Pre-state: onboarding-named
# Trigger: @bro review before push

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

EXPECTED="$L6_DOGFOOD_DIR/expected/06-push-gate.txt"
if [ ! -f "$EXPECTED" ]; then
  echo "  ⊘ skip: 06-push-gate expected-trajectory not yet authored"
  exit 0
fi

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

l6_run_claude "$PROJECT" "@bro review before push" >/dev/null

l6_assert_trajectory "$PROJECT" "$EXPECTED"
