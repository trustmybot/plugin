#!/usr/bin/env bash
# UserPromptSubmit hook. When the user's prompt expresses *architectural
# intent* — switching auth providers, swapping DB engines, introducing a
# new service boundary, modifying a public API, etc. — inject a hint
# reminding bro to author an ADR alongside the `kind='decision'`
# discussion required by the (universal) decision gate.
#
# Replaces the old simple/difficult triage as the architectural-rigor
# trigger: instead of bro classifying intent up-front, file-pattern +
# keyword heuristics fire the ADR reminder at prompt-submit time.
#
# Bypass: TMB_DISABLE_ADR_HINT=1.
# Always silent on failure; never blocks.

set -uo pipefail

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_ADR_HINT:-0}" = "1" ]; then
  exit 0
fi

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -n "$PROMPT" ] || exit 0

# Architectural intent. Precision-first; tolerate intermediate words.
matched=""
for pat in \
  'switch to clerk' 'switch to auth0' 'switch to okta' 'swap our auth' \
  'switch our auth' 'change our auth' 'migrate to postgres' 'migrate to mysql' \
  'migrate from postgres' 'migrate from mysql' 'switch to sqlite' \
  'switch to postgres' 'switch to mysql' 'migrate storage' 'swap our db' \
  'swap the db' 'switch our db' 'replace our db' \
  'introduce a new service' 'new service boundary' 'new module boundary' \
  'public api' 'new public api' 'change the public api' \
  'strategic stack' 'production db' 'retention policy' \
  'use react instead' 'use vue instead' 'use svelte instead' \
  'use fastapi instead' 'use django instead' 'use flask instead' \
  'rewrite ... in' 'port ... to' 'replatform' \
  'extract the storage layer' 'extract the storage' 'storage interface' \
  'storage backend' 'backend interface' 'pluggable backend' \
  'pluggable storage' 'swap between' 'plugin loader' \
  'plugin architecture' 'dependency inversion'; do
  case "$PROMPT" in
    *"$pat"*)
      matched="$pat"
      break
      ;;
  esac
done

[ -n "$matched" ] || exit 0

REASON="🏛️  architectural-change hint: the user's prompt contains '${matched}'. This change crosses TMB's architectural threshold (per skills/tmb_planning/SKILL.md §\"Architectural changes\"). In addition to the standard \`discussion_append(kind='decision', body=...)\` row required by the universal decision gate, you should also:

1. Co-author an ADR at \`docs/trustmybot/architecture/manual/decisions/N-*.md\`. Template: \`templates/docs-trustmybot/architecture/manual/decisions/0001-example.md\`.
2. Apply the blast-radius checklist if the feature has external side effects (network, real API mutations, billing, message-sending, writes outside the worktree) — default config opt-in / safe; tests use \`:memory:\` / no live services; spec requires pre-merge \`bash tests/run-all.sh\` with zero external mutations.
3. Architecture-doc refresh is automatic — \`post-task-close-rescan.sh\` runs \`scan_run\` after \`bro_atomic_close\` (Step 6 of the planning skill).

If the user wants to deliberate before bro commits, recommend they enter Claude Code plan mode (Shift+Tab) — bro doesn't run a bespoke Q+A loop."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $reason
  }
}'

exit 0
