#!/usr/bin/env bash
# 05.07-halt-on-error L5 isolation: onboarding-named fixture seeds identity.
# No extra pre-state — DB has no tasks (bro must get error on task 99999).
set -uo pipefail

# shellcheck disable=SC2034
PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

: