#!/usr/bin/env bash
# 32-team-config L5 isolation: onboarding-named fixture already seeds identity
# with branching_model='github-flow'. No extra pre-state required.
set -uo pipefail

# shellcheck disable=SC2034
PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

: