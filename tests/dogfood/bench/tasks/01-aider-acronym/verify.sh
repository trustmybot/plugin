#!/usr/bin/env bash
# Run the pytest suite for the Acronym task. Exits 0 iff all 7 tests pass.
set -uo pipefail

PROJECT="${1:?project dir required}"
# shellcheck disable=SC2034
TASK_DIR="${2:-}"

cd "$PROJECT" || exit 2
# Use pytest directly (PATH-resolved). `python -m pytest` picks the wrong
# python on systems where the default `python` is from a user-local venv
# that lacks pytest.
if ! command -v pytest >/dev/null 2>&1; then
  echo "verify.sh: pytest not found in PATH" >&2
  exit 2
fi
pytest -q tests/test_acronym.py
