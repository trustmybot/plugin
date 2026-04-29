#!/usr/bin/env bash
# L5 v2 — C-consultant (FLOWS.md §C)
# Pre-seeds .claude/agents/architect.md so bro can spawn it directly.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="C-consultant"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro get the architect's read on whether SQLite WAL mode is sufficient for our concurrency model"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

mkdir -p "$PROJECT/.claude/agents"
cp "$PLUGIN_ROOT/templates/agents/architect.md" "$PROJECT/.claude/agents/architect.md"

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
