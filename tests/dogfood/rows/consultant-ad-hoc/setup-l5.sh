#!/usr/bin/env bash
# consultant-ad-hoc L5 isolation: copies architect.md from plugin templates
# so bro can spawn it directly via Agent.
set -uo pipefail

PROJECT="$1"
# shellcheck disable=SC2034
SCENARIO_DIR="$2"

mkdir -p "$PROJECT/.claude/agents"
cp "$PLUGIN_ROOT/templates/agents/architect.md" "$PROJECT/.claude/agents/architect.md"