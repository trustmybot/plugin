#!/usr/bin/env bash
# Cold-start scenario: no pre-state to seed beyond the empty fixture.
set -uo pipefail

# shellcheck disable=SC2034  # PROJECT + SCENARIO_DIR passed by runner; reserved for future use
PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

# Nothing to do — the empty fixture already left identity / plugin_config
# / audit untouched. Bro should detect this and auto-fire onboard.
:
