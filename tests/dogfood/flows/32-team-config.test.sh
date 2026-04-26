#!/usr/bin/env bash
# L6 flow 32-team-config — Issue #32 — Onboarding pre-selects from .claude/tmb/config.json
#
# SCAFFOLD — fill in the expected-trajectory file before enabling.
# Until then this test is a no-op skip.
#
# Pre-state: empty
# Trigger: @bro hi

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/flow-helpers.sh"

EXPECTED="$L6_DOGFOOD_DIR/expected/32-team-config.txt"
if [ ! -f "$EXPECTED" ]; then
  echo "  ⊘ skip: 32-team-config expected-trajectory not yet authored"
  exit 0
fi

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

l6_seed_db "$PROJECT" "empty"

l6_run_claude "$PROJECT" "@bro hi" >/dev/null

l6_assert_trajectory "$PROJECT" "$EXPECTED"
