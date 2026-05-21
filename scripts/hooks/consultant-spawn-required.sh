#!/usr/bin/env bash
# UserPromptSubmit hook — when the user's message looks like it's asking
# bro to make a domain-expert call (security, performance, legal, scaling,
# architecture trade-off), inject `additionalContext` reminding bro to
# invoke the `/tmb:agent-create <role>` slash command rather than answering
# from general knowledge.
#
# This hook is the **deterministic enforcement surface** for consultant
# spawning: the consultant routing row was removed from CLAUDE.md (#198
# part 2) to keep the always-loaded persona slim, and the previous
# `tmb_agent-creator` skill's description-match autoload turned out to be
# unreliable. The slash command is the one path that combines reliably
# with hooks — see EVALUATION.md §"L5/L6 contract" + the claude-code-guide
# write-up on UserPromptExpansion vs Skill autoload.
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
    *"perf"*|*"latency"*|*"throughput"*|*"bottleneck"*|*"scaling"*|*"scales"*|*" scale"*|*"benchmark"*) DOMAIN="perf" ;;
    *"legal"*|*"licensing"*|*"compliance"*|*"gdpr"*|*"pii"*|*"copyright"*) DOMAIN="legal" ;;
    *"architecture decision"*|*"trade-off"*|*"tradeoff"*|*"design choice"*|*"adr"*|*"architecture trade"*|*"architectural trade"*) DOMAIN="architect" ;;
    *"json or sqlite"*|*"sqlite or postgres"*|*"postgres or sqlite"*|*"sqlite vs postgres"*|*"sql or nosql"*|*"storage"*"scale"*) DOMAIN="architect" ;;
    *)
      # Pattern fallback: "what's the X implication" / "is X safe under Y" /
      # "should we use X over Y" / "should we keep X or move to Y" —
      # advisory-flavoured questions.
      case "$LOWER" in
        *"implication"*|*"trade-off"*|*"should we use"*|*"better to use"*|*"should we keep"*|*"should we move"*|*"should we commit to"*) DOMAIN="advisory" ;;
      esac
      ;;
  esac
fi

[ -z "$NAMED_ROLE" ] && [ -z "$DOMAIN" ] && exit 0

if [ -n "$NAMED_ROLE" ]; then
  # Registry is the source of truth for agents. Even when the user names a
  # specific role, bro must use the /tmb:agent-create command, which runs
  # agent_list + scope resolution + Branch A/B/C routing. Direct Agent
  # calls without that ceremony bypass the registry, leave the agents
  # table unregistered, and risk using a stale .claude/agents/ file.
  CONTEXT="[tmb consultant-spawn enforcement] The user's prompt names the \`${NAMED_ROLE}\` role. Invoke \`/tmb:agent-create ${NAMED_ROLE} <one-line restatement of the user question>\` — the command runs the full agent_list + Branch A/B/C ceremony AND spawns the consultant in the same call. Bare \`Agent(subagent_type='${NAMED_ROLE}')\` without the command bypasses the registry; do NOT take that shortcut."
else
  CONTEXT="[tmb consultant-spawn enforcement] The user's prompt looks like a \`${DOMAIN}\` judgment call. Invoke \`/tmb:agent-create <role> <one-line restatement>\` with the role that fits this domain (architect / cto / pm / legal-reviewer / a custom from-scratch role). The slash command handles the full ceremony — agent_list lookup, Branch A/B/C routing, audit, spawn — deterministically. Answering directly from general knowledge bypasses the consultant gate."
fi

jq -nc --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
exit 0
