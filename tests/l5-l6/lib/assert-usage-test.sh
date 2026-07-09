#!/usr/bin/env bash
# Self-test for assert-usage.sh (issue #119). Feeds tmb_usage_in_log a small
# sample stream-json run log and asserts it detects an invoked skill, accepts
# bare/prefixed name forms, and rejects a skill that never fired.
# Run: bash tests/l5-l6/lib/assert-usage-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/assert-usage.sh"

PASS=0
FAIL=0
TMP=$(mktemp -d -t assert-usage-test-XXXX)
trap 'rm -rf "$TMP"' EXIT

assert_detect() {
  local label="$1" log="$2" name="$3" want="$4"
  tmb_usage_in_log "$log" "$name"
  local got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS + 1))
    echo "  PASS $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL $label — expected exit=$want, got exit=$got"
  fi
}

# ---- Sample stream-json run log: bro invokes tmb:tmb_planning -------------
# Mirrors a real `claude -p --output-format stream-json --verbose` stream:
# a system/init event listing loaded plugins, then an assistant message whose
# content carries a Skill tool_use, then the tool_result text.
SKILL_LOG="$TMP/skill-invoked.jsonl"
cat > "$SKILL_LOG" <<'EOF'
{"type":"system","subtype":"init","session_id":"s1","plugins":["tmb@trustmybot"],"tools":["Skill","Bash"]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Loading the planning skill."},{"type":"tool_use","id":"tu_1","name":"Skill","input":{"skill":"tmb:tmb_planning"}}]}}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"Launching skill: tmb:tmb_planning"}]}}
{"type":"result","subtype":"success","duration_ms":1234}
EOF

# ---- Sample run log where NO skill fired ----------------------------------
NO_SKILL_LOG="$TMP/no-skill.jsonl"
cat > "$NO_SKILL_LOG" <<'EOF'
{"type":"system","subtype":"init","session_id":"s2","plugins":["tmb@trustmybot"],"tools":["Bash"]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Just running a command."},{"type":"tool_use","id":"tu_9","name":"Bash","input":{"command":"ls"}}]}}
{"type":"result","subtype":"success","duration_ms":42}
EOF

echo "== detect: skill invoked (prefixed query) =="
assert_detect "tmb:tmb_planning in skill log" "$SKILL_LOG" "tmb:tmb_planning" 0

echo "== detect: skill invoked (bare query matches prefixed log) =="
assert_detect "tmb_planning (bare) in skill log" "$SKILL_LOG" "tmb_planning" 0

echo "== reject: skill not invoked =="
assert_detect "tmb_planning absent from no-skill log" "$NO_SKILL_LOG" "tmb_planning" 1

echo "== reject: different skill not invoked =="
assert_detect "tmb_review absent from skill log" "$SKILL_LOG" "tmb_review" 1

echo "== detect: plugin presence via init plugins[] =="
assert_detect "tmb@trustmybot plugin loaded" "$SKILL_LOG" "tmb@trustmybot:tmb_planning" 0

echo "== reject: missing run log =="
assert_detect "nonexistent log → fail" "$TMP/does-not-exist.jsonl" "tmb_planning" 1

echo
echo "assert-usage-test: $PASS pass / $FAIL fail"
[ "$FAIL" = "0" ] && exit 0 || exit 1
