#!/usr/bin/env bash
# L6 flow 07-architecture-regen — FLOWS.md §7 — Architecture regen
#
# SCAFFOLD — fill in the expected-trajectory file before enabling.
# Until then this test is a no-op skip.
#
# Pre-state: onboarding-named
# Trigger: @bro refresh architecture docs

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

EXPECTED="$L6_DOGFOOD_DIR/expected/07-architecture-regen.txt"
if [ ! -f "$EXPECTED" ]; then
  echo "  ⊘ skip: 07-architecture-regen expected-trajectory not yet authored"
  exit 0
fi

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

l6_run_claude "$PROJECT" "@bro refresh architecture docs" >/dev/null

l6_assert_trajectory "$PROJECT" "$EXPECTED"
