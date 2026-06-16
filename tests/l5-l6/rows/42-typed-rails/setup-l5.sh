#!/usr/bin/env bash
# 42-typed-rails L5 isolation: onboarding-named fixture seeds identity; no extra
# pre-state. The row exercises Typed Rails (#673) — a code-touching ask should
# flow through task_create_batch, and the created task row must carry the typed
# files/verification columns (JSON arrays). bro's emission of the typed fields
# lives in the tmb_planning skill (sibling Task B) and ships in the same set.
set -uo pipefail

# shellcheck disable=SC2034
PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

:
