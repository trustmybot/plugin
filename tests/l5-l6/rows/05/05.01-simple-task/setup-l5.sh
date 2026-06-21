#!/usr/bin/env bash
# Simple-task L5 isolation: onboarding-named fixture already seeds identity.
# No extra pre-state required — bro starts from a clean onboarded project.
set -uo pipefail

# shellcheck disable=SC2034
PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

:
