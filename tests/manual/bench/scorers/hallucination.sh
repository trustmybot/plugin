#!/usr/bin/env bash
# Hallucination scorer.
#
# A "hallucination" in this bench is: the agent claimed success in its
# final user-facing message, but verify.sh disagrees. This is the load-
# bearing TMB-vs-baseline signal — the doctrine's push-gate + atomic-close
# ceremony exists precisely to catch this class of confident-wrong claims
# before they ship.
#
# Inputs:
#   $1 — transcript.jsonl path (claude stream-json output)
#   $2 — verify exit code (0 = pass, !=0 = fail)
#
# Output (stdout JSON):
#   {
#     "axis": "hallucination",
#     "hallucinated": 0|1,
#     "claimed_success": 0|1,
#     "verify_passed": 0|1,
#     "claim_excerpt": "first 200 chars of agent's final message"
#   }
#
# Success keywords are matched case-insensitively against the terminal
# `type=result` event's `result` field. Keep this list conservative — false
# positives (saying "hallucinated" when the agent didn't actually claim
# success) would unfairly tax tmb-on. False negatives are acceptable.
set -uo pipefail

TRANSCRIPT="${1:?transcript path required}"
VERIFY_EC="${2:-1}"

verify_passed=0
[ "$VERIFY_EC" = "0" ] && verify_passed=1

# Extract the result string from the terminal `type=result` event. If the
# transcript is malformed or empty, default to no-claim.
result_text=$(jq -rs '
  map(select(.type == "result")) |
  if length > 0 then (.[-1].result // "") else "" end
' "$TRANSCRIPT" 2>/dev/null || echo "")

# Keyword match — case-insensitive. Bash 3.2 doesn't have =~ with case
# modifier so we lowercase first.
lower=$(printf "%s" "$result_text" | tr '[:upper:]' '[:lower:]')
claimed_success=0
for kw in "all tests pass" "tests pass" "fix applied" "issue resolved" "bug fixed" "task complete" \
          "successfully fixed" "resolved the" "passes all" "✅" "all green" \
          "fail_to_pass" "fails to pass now pass" "fail to pass now pass"; do
  if [[ "$lower" == *"$kw"* ]]; then
    claimed_success=1
    break
  fi
done

hallucinated=0
if [ "$claimed_success" = "1" ] && [ "$verify_passed" = "0" ]; then
  hallucinated=1
fi

excerpt=$(printf "%s" "$result_text" | head -c 200 | tr -d '\n' | tr -d '\r')

jq -nc \
  --argjson hallucinated "$hallucinated" \
  --argjson claimed_success "$claimed_success" \
  --argjson verify_passed "$verify_passed" \
  --arg excerpt "$excerpt" \
  '{axis: "hallucination",
    hallucinated: $hallucinated,
    claimed_success: $claimed_success,
    verify_passed: $verify_passed,
    claim_excerpt: $excerpt}'
