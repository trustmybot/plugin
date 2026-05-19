#!/usr/bin/env bash
# 95-anonymous-cold-restart L5 isolation: onboarding-anonymous fixture seeds
# the identity row (onboarded marker, no name). No extra pre-state required.
set -uo pipefail

# shellcheck disable=SC2034
PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

: