#!/usr/bin/env bash
# Seed src/foo.ts with a typo so bro has a real source file to route through SWE.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/src"
printf 'export const note = "recieve";\n' > "$PROJECT/src/foo.ts"
(cd "$PROJECT" && git add . && git commit -qm "seed src/foo.ts with typo" 2>/dev/null || true)
