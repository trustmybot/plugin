#!/usr/bin/env bash
set -uo pipefail

trap 'exit 0' ERR

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null) || exit 0
[ "$TOOL_NAME" = "AskUserQuestion" ] || exit 0

IS_ERROR=$(echo "$INPUT" | jq -r '.tool_response.is_error // false' 2>/dev/null) || true

ERROR_PATTERNS=(
  "tool errored on both attempts"
  "Tool execution failed"
)

detect_error_in_content() {
  local content
  content=$(echo "$INPUT" | jq -r '
    if .tool_response.content then
      [.tool_response.content[] | select(.text) | .text] | join("\n")
    elif (.tool_response | type) == "string" then
      .tool_response
    else
      ""
    end
  ' 2>/dev/null) || true

  for pattern in "${ERROR_PATTERNS[@]}"; do
    if echo "$content" | grep -qi "$pattern" 2>/dev/null; then
      return 0
    fi
  done

  if echo "$content" | grep -qiE "error.*AskUserQuestion" 2>/dev/null; then
    return 0
  fi

  return 1
}

if [ "$IS_ERROR" != "true" ] && ! detect_error_in_content; then
  exit 0
fi

CONTEXT="<<<TMB-AUQ-ERROR-FALLBACK>>>
AskUserQuestion errored — no Human in the loop. Per \`tmb_headless-fallback\` doctrine (mandatory):
1. Load the \`tmb_headless-fallback\` skill via \`Skill(skill='tmb:tmb_headless-fallback')\`.
2. Look up the calling skill's \`## Headless fallback\` documented default (every AUQ-calling skill MUST have one).
3. Emit BOTH writes — \`audit_log(kind='event', event_type='headless_fallback', summary=...)\` AND \`discussion_append(kind='note', body=...)\` — on bro's behalf.
4. Continue the parent flow with the documented default value as if the Human had typed it.
5. Do NOT retry the AskUserQuestion call with different phrasing — the first error is the signal to fall back, not to rephrase.
For file-writing creator skills (\`tmb_skill-creator\`, \`tmb_agent-creator\`), the documented default is \`headless_creator_blocked\` HALT instead of an autopick — still emit the audit_log event before halting.
<<</TMB-AUQ-ERROR-FALLBACK>>>"

jq -n --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'

exit 0
