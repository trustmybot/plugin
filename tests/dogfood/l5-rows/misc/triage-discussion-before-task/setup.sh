#!/usr/bin/env bash
# Seed source so bro has something to plan against.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
cat > "$PROJECT/src/cli.py" <<'PY'
"""TODO CLI entry point — stub."""
def main():
    print("noop")
PY
(
  cd "$PROJECT" || exit 1
  git add src/cli.py
  git commit -qm 'feat: scaffold cli.py'
) >/dev/null
