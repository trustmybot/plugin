#!/usr/bin/env bash
# Fixture: denies directly.
cat >/dev/null
jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"fx"}}'
