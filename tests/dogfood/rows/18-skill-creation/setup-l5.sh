#!/usr/bin/env bash
# No extra pre-state beyond onboarding-named fixture — bro triggers skill-creator
# from a clean onboarded project.
set -uo pipefail

# shellcheck disable=SC2034
PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

:
