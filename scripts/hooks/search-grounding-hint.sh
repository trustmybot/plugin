#!/usr/bin/env bash
# UserPromptSubmit hook. When the user asks bro a "why did we X" / "what
# was the rationale" / "what did we decide" question — i.e. a retrieval
# question over past decisions — inject a hint nudging bro toward the
# *_search MCP tools (discussion_search, audit_search, file_registry_search)
# instead of the linear-scan *_list / *_get_with_discussions tools.
#
# Motivation: CLAUDE.md already documents the search-first preference, but
# bro's tool selection is non-deterministic — on a marginal turn it may
# default to discussion_list(issue_id=N). The hook makes the preference
# *salient at prompt-submit time*, which empirically holds the line.
#
# Bypass: TMB_DISABLE_SEARCH_HINT=1.
# Always silent on failure; never blocks.

set -uo pipefail

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_SEARCH_HINT:-0}" = "1" ]; then
  exit 0
fi

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -n "$PROMPT" ] || exit 0

matched=""
for pat in \
  'why did we' 'why we chose' 'why we picked' 'why we decided' \
  'why was' 'why is' 'why are we' \
  'what was the rationale' 'what is the rationale' \
  'what did we decide' 'what was decided' 'what was our decision' \
  'how did we decide' 'when did we decide' \
  'rationale for' 'reasoning behind' \
  'past decision' 'prior decision' 'previous decision' \
  'find the discussion' 'search the discussion' 'search discussions' \
  'recall why' 'remind me why'; do
  case "$PROMPT" in
    *"$pat"*)
      matched="$pat"
      break
      ;;
  esac
done

[ -n "$matched" ] || exit 0

REASON="🔎 search-grounding hint: the user's prompt contains '${matched}' — a retrieval question over past decisions.

Prefer the *_search MCP tools over linear scans:
- \`discussion_search(query='<key terms>', mode='hybrid')\` returns ranked snippets across ALL issues (keyword + semantic). Use this first.
- \`audit_search(query='<key terms>')\` for event-history grounding.
- \`file_registry_search(query='<key terms>')\` for code-context grounding.

Only fall back to \`discussion_list(issue_id=N)\` / \`issue_get_with_discussions\` once \`discussion_search\` has narrowed the candidate set — those tools enumerate, they don't rank. Hybrid mode auto-falls-back to keyword if the embedding model is offline (\`warning: 'semantic_unavailable'\`)."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $reason
  }
}'

exit 0
