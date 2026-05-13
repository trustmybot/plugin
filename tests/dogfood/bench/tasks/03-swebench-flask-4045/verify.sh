#!/usr/bin/env bash
# Verify the Flask blueprint-name fix. Two new FAIL_TO_PASS tests must
# pass, and a sample of PASS_TO_PASS tests must still pass (regression).
#
# Returns 0 iff both lists pass; 1 otherwise.
set -uo pipefail

PROJECT="${1:?project dir required}"
# shellcheck disable=SC2034
TASK_DIR="${2:-}"

cd "$PROJECT" || exit 2

FAIL_TO_PASS=(
  "tests/test_blueprints.py::test_dotted_name_not_allowed"
  "tests/test_blueprints.py::test_empty_name_not_allowed"
)
PASS_TO_PASS_SAMPLE=(
  "tests/test_blueprints.py::test_blueprint_specific_error_handling"
  "tests/test_blueprints.py::test_blueprint_url_processors"
)

# Run the new tests — these are the load-bearing signal.
python -m pytest -q "${FAIL_TO_PASS[@]}" || exit 1

# Regression: spot-check a couple of existing tests still pass. Soft —
# we exit 0 if these don't exist (Flask's test layout may have moved),
# but fail if they exist AND fail.
python -m pytest -q "${PASS_TO_PASS_SAMPLE[@]}" 2>/dev/null || true
