#!/usr/bin/env bash
# PreToolUse hook (#153 fix-2-v2). Blocks AskUserQuestion when TMB_HEADLESS=1
# is set (CI / headless / scripted runs). Emits a deny decision with fallback
# instructions so the caller loads tmb_headless-fallback and auto-picks.
set -uo pipefail

trap 'exit 0' ERR

INPUT=$(cat 2>/dev/null) || exit 0
if ! command -v jq >/dev/null 2>&1; then exit 0; fi

TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
[ "$TOOL" = "AskUserQuestion" ] || exit 0

HEADLESS="${TMB_HEADLESS:-}"
[ "$HEADLESS" = "1" ] || exit 0

REASON='<<<TMB-HEADLESS-AUQ-DENIED>>>
TMB_HEADLESS=1 is set — AskUserQuestion is unavailable in this run (CI / headless / scripted). Per `tmb_recovery` §A doctrine (mandatory):
1. Load the `tmb_recovery` skill via `Skill(skill='"'"'tmb:tmb_recovery'"'"')`.
2. Look up the calling skill'"'"'s documented default in `tmb_recovery skill body` §A "Per-skill defaults" (or in the calling skill'"'"'s own headless section).
3. Emit BOTH writes — `audit_log(kind='"'"'event'"'"', event_type='"'"'headless_fallback'"'"', summary=...)` AND `discussion_append(kind='"'"'note'"'"', body=...)` — on bro'"'"'s behalf.
4. Continue the parent flow with the documented default value as if the Human had typed it.
5. Skip retrying the AskUserQuestion call with different phrasing — the deny is the signal to fall back, not to rephrase.
For file-writing creator skills (`tmb_skill-creator`, `tmb_agent-creator`), the documented default is `headless_creator_blocked` HALT instead of an autopick — still emit the audit_log event before halting.
<<<TMB-HEADLESS-AUQ-DENIED>>>'

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'

exit 0
