#!/usr/bin/env bash
# UserPromptSubmit hook — when the user's message looks like it's asking
# bro to make a domain-expert call (security, performance, legal, scaling,
# architecture trade-off), inject `additionalContext` reminding bro to
# spawn a consultant via tmb_agent-creator rather than answering from
# general knowledge.
#
# Consultant patterns are surfaced by keyword detection; the actual
# decision (which consultant, when not to spawn one) stays in the bro
# concerns-protocol skill — judgment-bound.
#
# Silent unless a pattern matches.

set -uo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null)
[ -n "$PROMPT" ] || exit 0

# Skip the hook when the trajectory DB isn't present (not a TMB project
# session, no consultants to spawn).
DB_PATH="${TRAJECTORY_DB_PATH:-}"
if [ -z "$DB_PATH" ]; then
  PLUGIN_NAME="tmb"
  if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" ]; then
    PLUGIN_NAME=$(jq -r '.name // "tmb"' "${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json" 2>/dev/null || echo "tmb")
  fi
  DB_PATH="$PWD/.claude/$PLUGIN_NAME/trajectory.db"
fi
[ -f "$DB_PATH" ] || exit 0

LOWER=$(printf '%s' "$PROMPT" | tr '[:upper:]' '[:lower:]')

# Domain-expert keyword classes. Each class names the consultant role
# bro should consider spawning.
DOMAIN=""
case "$LOWER" in
  *"security"*|*"vulnerability"*|*"injection"*|*"xss"*|*"csrf"*|*"auth bypass"*) DOMAIN="security" ;;
  *"perf"*|*"latency"*|*"throughput"*|*"bottleneck"*|*"scaling"*|*"benchmark"*) DOMAIN="perf" ;;
  *"legal"*|*"licensing"*|*"compliance"*|*"gdpr"*|*"pii"*|*"copyright"*) DOMAIN="legal" ;;
  *"architecture decision"*|*"trade-off"*|*"tradeoff"*|*"design choice"*|*"adr"*) DOMAIN="architect" ;;
  *)
    # Pattern fallback: "what's the X implication" / "is X safe under Y" /
    # "should we use X over Y" — these cluster on advisory questions.
    case "$LOWER" in
      *"implication"*|*"trade-off"*|*"should we use"*|*"better to use"*) DOMAIN="advisory" ;;
    esac
    ;;
esac

[ -z "$DOMAIN" ] && exit 0

# Don't fire if the user already mentions a consultant or agent role.
case "$LOWER" in
  *"consultant"*|*"architect"*|*"cto"*|*"ceo"*|*"pm"*|*"agent-creator"*) exit 0 ;;
esac

CONTEXT="[tmb consultant-spawn hint] The user's prompt looks like a ${DOMAIN} judgment call. If the existing roster (\`.claude/agents/\`) doesn't already include a fitting consultant, propose \`tmb_agent-creator\` to spawn one in analysis-only mode (per tmb_concerns-protocol Path B). Decide whether to spawn — this hint is advisory."

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
exit 0
