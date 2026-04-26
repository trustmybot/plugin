#!/usr/bin/env bash
# L6 flow 96-halt-on-error — Issue #96 — bro halts on MCP forbidden errors
#
# SCAFFOLD — fill in the expected-trajectory file before enabling.
# Until then this test is a no-op skip.
#
# Pre-state: onboarding-named
# Trigger: @bro mark task 1 as validated

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

EXPECTED="$L6_DOGFOOD_DIR/expected/96-halt-on-error.txt"
if [ ! -f "$EXPECTED" ]; then
  echo "  ⊘ skip: 96-halt-on-error expected-trajectory not yet authored"
  exit 0
fi

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

l6_run_claude "$PROJECT" "@bro mark task 1 as validated" >/dev/null

l6_assert_trajectory "$PROJECT" "$EXPECTED"
