#!/usr/bin/env bash
# L6 flow 03-difficult-task — FLOWS.md §3 — Difficult Task (architecture-touching)
#
# SCAFFOLD — fill in the expected-trajectory file before enabling.
# Until then this test is a no-op skip.
#
# Pre-state: onboarding-named
# Trigger: @bro design a new auth subsystem with OAuth + session token storage

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

EXPECTED="$L6_DOGFOOD_DIR/expected/03-difficult-task.txt"
if [ ! -f "$EXPECTED" ]; then
  echo "  ⊘ skip: 03-difficult-task expected-trajectory not yet authored"
  exit 0
fi

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

l6_run_claude "$PROJECT" "@bro design a new auth subsystem with OAuth + session token storage" >/dev/null

l6_assert_trajectory "$PROJECT" "$EXPECTED"
