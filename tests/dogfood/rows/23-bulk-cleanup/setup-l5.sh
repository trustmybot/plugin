#!/usr/bin/env bash
# Scatter .DS_Store files at three depths + seed keep-list files.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

touch "$PROJECT/.DS_Store"
mkdir -p "$PROJECT/src/components"
touch "$PROJECT/src/.DS_Store"
touch "$PROJECT/src/components/.DS_Store"

echo "console.log('hello');" > "$PROJECT/src/index.js"
echo "export default {};"    > "$PROJECT/src/components/App.js"

(cd "$PROJECT" && git add . && git commit -qm "seed: add .DS_Store + keep-list" 2>/dev/null || true)
