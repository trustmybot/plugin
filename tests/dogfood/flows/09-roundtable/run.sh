#!/usr/bin/env bash
# L5 v2 — 09-roundtable (FLOWS.md §9)
# Pre-seeds architect.md + pm.md so roundtable has ≥2 valid participants.

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/flow-helpers.sh"

FLOW_NAME="09-roundtable"
RUN_ID="${RUN_ID:-$(date +%s)-$RANDOM}"
PROMPT="@bro convene a roundtable with architect and pm on whether to migrate to event-sourced storage"

PROJECT=$(l5_setup_scratch_project)
trap 'l5_cleanup_project "$PROJECT"' EXIT

l5_seed_db "$PROJECT" "onboarding-named"

mkdir -p "$PROJECT/.claude/agents"
cp "$PLUGIN_ROOT/templates/agents/architect.md" "$PROJECT/.claude/agents/architect.md"
cp "$PLUGIN_ROOT/templates/agents/pm.md"        "$PROJECT/.claude/agents/pm.md"

l5_run_claude "$PROJECT" "$PROMPT"
l5_score_flow "$PROJECT" "$FLOW_NAME" "$HERE" "$RUN_ID"
