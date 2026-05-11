#!/usr/bin/env bash
# UserPromptSubmit hook. When the user prompt contains doubt-class
# phrases that suggest a request bro should push back on, inject
# `additionalContext` reminding bro to apply tmb_concerns-protocol
# before complying.
#
# Pattern catalog (selected for high precision, low recall — false
# negatives preferred over false positives so we don't badger bro on
# legitimate requests):
#
#   "delete the test", "remove the test", "skip the test", "skip the
#   tests", "skip validation", "skip verification", "skip the gate",
#   "force push", "ignore the gate", "just do it", "just push it",
#   "bypass the check", "weaken the assertion", "loosen the check",
#   "switch to approxequal", "use approxequal", "replace exact equality",
#   "change to approx", "approxequal with tolerance"
#
# Captures L6 scenario 05 — bro yes-and on ambiguous test edits without
# surfacing concern.
#
# Bypass: TMB_DISABLE_CONCERNS_HINT=1.
# Always silent on failure; never blocks.

set -uo pipefail

INPUT=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0

if [ "${TMB_DISABLE_CONCERNS_HINT:-0}" = "1" ]; then
  exit 0
fi

PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null | tr '[:upper:]' '[:lower:]')
[ -n "$PROMPT" ] || exit 0

# Pattern detection. Each is a literal substring match for precision.
matched=""
for pat in \
  'delete the test' 'remove the test' 'skip the test' 'skip the tests' \
  'skip validation' 'skip verification' 'skip the gate' 'force push' \
  'ignore the gate' 'just do it' 'just push it' 'bypass the check' \
  'weaken the assertion' 'loosen the check' 'just delete' 'just remove' \
  'switch to approxequal' 'use approxequal' 'replace exact equality' \
  'change to approx' 'approxequal with tolerance'; do
  case "$PROMPT" in
    *"$pat"*)
      matched="$pat"
      break
      ;;
  esac
done

[ -n "$matched" ] || exit 0

REASON="🚨 concerns-protocol hint: the user's prompt contains the phrase '${matched}'. This is a doubt-class request — apply tmb_concerns-protocol before complying:

1. Read the relevant file(s) to verify the constraint the user is asking you to weaken is real.
2. If the request fights an existing-and-correct constraint, write \`discussion_append(agent='bro', kind='note', body='Concern: <one-line statement>. Recommendation: <alternative>.')\` BEFORE any task_create_batch.
3. Ask the Human a clarifying question; do NOT silently comply.

If you've already verified the request is legitimate (e.g., the user is right about a refactor), proceed normally — but the concern record protects against future regressions."

jq -nc --arg reason "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $reason
  }
}'

exit 0
