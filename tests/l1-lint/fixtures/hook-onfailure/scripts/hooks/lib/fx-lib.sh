#!/usr/bin/env bash
# Fixture library for hook-onfailure.sh --self-test.

fx_context() {
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:"fx"}}'
}

tmb_deny_fx() {
  jq -nc '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"fx"}}'
}
