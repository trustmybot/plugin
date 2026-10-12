#!/usr/bin/env bash
# Fixture: denies, but allows silently when jq is missing.
cat >/dev/null
command -v jq >/dev/null 2>&1 || exit 0
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"fx"}}'
