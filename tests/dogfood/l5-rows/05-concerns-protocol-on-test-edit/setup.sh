#!/usr/bin/env bash
# Pre-seed a test file with an exact-equality assertion on what looks like
# integer arithmetic — substrate for the concerns-protocol scenario.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/tests"
cat > "$PROJECT/tests/test_calculator.py" <<'PY'
def add(a, b):
    return a + b

def test_add_returns_exact_integer():
    assert add(2, 3) == 5
PY

(
  cd "$PROJECT" || exit 1
  git add tests/test_calculator.py
  git commit -qm 'test: seed calculator test (exact equality)'
) >/dev/null
