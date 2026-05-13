#!/usr/bin/env bash
# Run the pytest suite for the Word-Count task. Exits 0 iff all 12 tests pass.
set -uo pipefail

PROJECT="${1:?project dir required}"
# shellcheck disable=SC2034
TASK_DIR="${2:-}"

cd "$PROJECT" || exit 2
python -m pytest -q tests/test_word_count.py
