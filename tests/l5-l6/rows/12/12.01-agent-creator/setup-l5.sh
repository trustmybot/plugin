#!/usr/bin/env bash
# Copy fixture app.py into the scratch project and commit it so the architect
# prompt has real SQLite + threading code to evaluate.
set -uo pipefail

PROJECT="$1"
SCENARIO_DIR="$2"

cp "$SCENARIO_DIR/fixture/app.py" "$PROJECT/app.py"
(cd "$PROJECT" && git add app.py && git commit -qm "seed app.py for architect review")
