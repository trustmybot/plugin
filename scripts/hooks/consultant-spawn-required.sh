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

# Two firing modes:
#   - DOMAIN keyword detected → suggest spawning a domain-fit consultant
#   - NAMED_ROLE detected     → remind bro to consult the registry (agent_list)
#                                before spawning, even when the role is explicit
#
# Consultant names are loaded from the agents-registry SQLite table — the
# canonical source of truth (#184). Hardcoding names would drift each time
# a project registers a new consultant.
NAMED_ROLE=""
if command -v sqlite3 >/dev/null 2>&1; then
  CONSULTANT_NAMES=$(sqlite3 "$DB_PATH" \
    "SELECT name FROM agents WHERE kind='consultant' AND status='active';" \
    2>/dev/null)
  while IFS= read -r role; do
    [ -n "$role" ] || continue
    role_lc=$(printf '%s' "$role" | tr '[:upper:]' '[:lower:]')
    case "$LOWER" in
      *"${role_lc}'s read"*|*"${role_lc}'s view"*|*"${role_lc}'s take"*|\
      *"${role_lc} agent"*|*"the ${role_lc} "*|*"the ${role_lc}."*|*"the ${role_lc},"*)
        NAMED_ROLE="$role_lc"
        break
        ;;
    esac
  done <<EOF
$CONSULTANT_NAMES
EOF
fi

# Domain-expert keyword classes. Each class names the consultant role
# bro should consider spawning when no specific role was named.
DOMAIN=""
if [ -z "$NAMED_ROLE" ]; then
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
fi

[ -z "$NAMED_ROLE" ] && [ -z "$DOMAIN" ] && exit 0

if [ -n "$NAMED_ROLE" ]; then
  # Post-#184 doctrine: the registry is the source of truth for agents.
  # Even when the user names a specific role, bro must call agent_list to
  # resolve scope (template vs project-local), then either copy + register
  # + spawn, or spawn directly. Skipping agent_list lets bro silently use
  # a stale .claude/agents/ file or miss a registered alternative.
  CONTEXT="[tmb consultant-spawn hint] The user's prompt names the ${NAMED_ROLE} role. Load \`tmb_agent-creator\` to look up ${NAMED_ROLE} in the agent registry (\`agent_list\`), resolve its scope, then spawn via \`Agent\`. Direct \`Agent\` calls without a registry consult bypass the source of truth (#184)."
else
  CONTEXT="[tmb consultant-spawn hint] The user's prompt looks like a ${DOMAIN} judgment call. If the existing roster (\`.claude/agents/\`) doesn't already include a fitting consultant, propose \`tmb_agent-creator\` to spawn one in analysis-only mode (per tmb_concerns-protocol Path B). Decide whether to spawn — this hint is advisory."
fi

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
exit 0
