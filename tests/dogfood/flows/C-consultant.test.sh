#!/usr/bin/env bash
# L6 flow C-consultant — FLOWS.md §C — Consultant invocation
#
# SCAFFOLD — fill in the expected-trajectory file before enabling.
# Until then this test is a no-op skip.
#
# Pre-state: onboarding-named
# Trigger: @bro get pm's view on the new feature

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

EXPECTED="$L6_DOGFOOD_DIR/expected/C-consultant.txt"
if [ ! -f "$EXPECTED" ]; then
  echo "  ⊘ skip: C-consultant expected-trajectory not yet authored"
  exit 0
fi

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

l6_run_claude "$PROJECT" "@bro get pm's view on the new feature" >/dev/null

l6_assert_trajectory "$PROJECT" "$EXPECTED"
