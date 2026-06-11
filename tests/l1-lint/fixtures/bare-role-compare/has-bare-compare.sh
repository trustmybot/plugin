#!/usr/bin/env bash
# Fixture: hook that compares a role string without sourcing normalize-role.sh.
# Used by tests/l1-lint/no-bare-role-compare.sh --self-test.

INPUT=$(cat)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // empty')
[ "$AGENT_TYPE" = "swe" ] || exit 0
echo "would block"
