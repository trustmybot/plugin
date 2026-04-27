#!/usr/bin/env bash
# L5 — 10-codebase-memory-cold-start (#45)
# Existing repo with files but empty file_registry → bro must trigger the
# AskUserQuestion in tmb_project-prescan. In headless mode (claude -p),
# AskUserQuestion errors → tmb_headless-fallback fires with default 'lazy',
# which records a headless_fallback ledger event. Outcome asserts that.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="10-codebase-memory-cold-start"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro implement a hello world function in src/hello.py"

PROJECT=$(l6_setup_scratch_project)
trap 'l6_cleanup_project "$PROJECT"' EXIT

# Seed an existing-repo state: identity exists (so onboarding doesn't fire),
# git ls-files non-empty (so cold-start trigger fires), file_registry empty.
l6_seed_db "$PROJECT" "onboarding-named"
mkdir -p "$PROJECT/src"
echo "# placeholder" > "$PROJECT/src/existing.py"
(cd "$PROJECT" && git add . && git commit -qm "seed existing files")

l6_run_claude "$PROJECT" "$PROMPT"
l6_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
