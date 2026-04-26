#!/usr/bin/env bash
# L6 flow 92-base-branch — Issue #92 — base-branch confirm with remote
#
# SCAFFOLD — fill in the expected-trajectory file before enabling.
# Until then this test is a no-op skip.
#
# Pre-state: onboarding-named
# Trigger: @bro write a python cli todo

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

EXPECTED="$L6_DOGFOOD_DIR/expected/92-base-branch.txt"
if [ ! -f "$EXPECTED" ]; then
  echo "  ⊘ skip: 92-base-branch expected-trajectory not yet authored"
  exit 0
fi

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "onboarding-named"

l6_run_claude "$PROJECT" "@bro write a python cli todo" >/dev/null

l6_assert_trajectory "$PROJECT" "$EXPECTED"
