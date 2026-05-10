#!/usr/bin/env bash
# Pre-seed the architect agent file so bro can spawn it via Agent without
# going through tmb_agent-creator's template-copy ceremony (out of scope
# for this scenario).
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034  # SCENARIO_DIR passed by runner; reserved for future use
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/.claude/agents"
cp "$PLUGIN_ROOT/templates/agents/architect.md" "$PROJECT/.claude/agents/architect.md"
