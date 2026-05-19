#!/usr/bin/env bash
# Seed todo.py so bro has existing code to analyse before designing the sync API.
# Mirrors the narrative that a prior simple-task run shipped the CLI.
set -uo pipefail

PROJECT="$1"
SCENARIO_DIR="$2"

cp "$SCENARIO_DIR/fixture/todo.py" "$PROJECT/todo.py"
(cd "$PROJECT" && git add todo.py && git commit -qm "feat: initial todo CLI")
