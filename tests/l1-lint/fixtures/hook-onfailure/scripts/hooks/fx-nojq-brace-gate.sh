#!/usr/bin/env bash
# Fixture: denies, but allows (with a note) when jq is missing.
cat >/dev/null
command -v jq >/dev/null 2>&1 || { echo "fx: jq not found" >&2; exit 0; }
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"fx"}}'
