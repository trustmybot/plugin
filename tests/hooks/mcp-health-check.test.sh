#!/usr/bin/env bash
# Tests for scripts/hooks/mcp-health-check.sh — the MCP trajectory-server
# liveness hook that fires on SessionStart + UserPromptSubmit.
#
# Coverage matrix:
#   1. Healthy + SessionStart        → silent stdout, JSONL mcp_alive=true mode=null
#   2. Healthy + UserPromptSubmit    → silent stdout, JSONL mode=null
#   3. Absent + SessionStart         → stdout has "NEVER STARTED", JSONL mode="A"
#   4. Absent + UPS (Mode A x-fire)  → same session as #3, stdout "NEVER STARTED"
#   5. Absent + UPS (Mode B)         → different session from a healthy SS, "no longer reachable"
#   6. Emitted output is valid JSON  → jq round-trip on cases 3-5
#   7. Schema validates against CC   → top-level hookSpecificOutput.{hookEventName,additionalContext}
#                                       — would have caught the rc.4/rc.5 "unknown" bug
#   8. Unknown event → no JSON       → silent stdout, JSONL still written with event preserved
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/mcp-health-check.sh"

LOG_DIR="$HOME/.claude/tmb/logs"
LOG_FILE="$LOG_DIR/mcp-health.log"
STATE_FILE="$LOG_DIR/mcp-health.state"

# The hook uses `pgrep -f 'trajectory-server/dist/index.js'` to detect the
# MCP server. We can't rely on the developer's machine having zero real
# trajectory-server processes, so we shadow pgrep via PATH with a stub that
# reads a "mock state" file controlled by the test harness.
STUB_DIR=$(mktemp -d)
MOCK_STATE="$STUB_DIR/mcp-mock.state"
cat > "$STUB_DIR/pgrep" <<EOF
#!/usr/bin/env bash
# Stub pgrep — only handles the trajectory-server query.
if [ -f "$MOCK_STATE" ] && [ "\$(cat "$MOCK_STATE")" = "alive" ]; then
  echo 99999
  exit 0
fi
exit 1
EOF
chmod +x "$STUB_DIR/pgrep"
export PATH="$STUB_DIR:$PATH"

cleanup() {
  rm -rf "$STUB_DIR"
}
trap cleanup EXIT

start_mock_trajectory_server() {
  echo "alive" > "$MOCK_STATE"
}

stop_mock_trajectory_server() {
  rm -f "$MOCK_STATE"
}

reset_state() {
  rm -f "$STATE_FILE"
}

last_jsonl() {
  tail -1 "$LOG_FILE" 2>/dev/null || echo "{}"
}

run_hook() {
  local input="$1"
  echo "$input" | bash "$HOOK" 2>/dev/null || true
}

mkdir -p "$LOG_DIR"

# ============================================================================
# Case 1 — Healthy + SessionStart
# ============================================================================
test_case "healthy + SessionStart: silent stdout"
reset_state
start_mock_trajectory_server
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"s1","source":"startup"}')
assert_eq "" "$out" "no additionalContext when MCP healthy"

test_case "healthy + SessionStart: JSONL mcp_alive=true mode=null"
line=$(last_jsonl)
assert_contains "$line" '"mcp_alive":true' "JSONL mcp_alive"
assert_contains "$line" '"mode":null' "JSONL mode"
assert_contains "$line" '"event":"SessionStart"' "JSONL event"

# ============================================================================
# Case 2 — Healthy + UserPromptSubmit
# ============================================================================
test_case "healthy + UserPromptSubmit: silent stdout"
out=$(run_hook '{"hook_event_name":"UserPromptSubmit","session_id":"s1"}')
assert_eq "" "$out" "no additionalContext when MCP healthy on UPS"

test_case "healthy + UserPromptSubmit: JSONL mode=null"
line=$(last_jsonl)
assert_contains "$line" '"mcp_alive":true' "JSONL mcp_alive on UPS"
assert_contains "$line" '"mode":null' "JSONL mode on UPS"

stop_mock_trajectory_server

# ============================================================================
# Case 3 — Absent + SessionStart (Mode A)
# ============================================================================
test_case "absent + SessionStart: stdout contains NEVER STARTED"
reset_state
out_c3=$(run_hook '{"hook_event_name":"SessionStart","session_id":"sA","source":"startup"}')
assert_contains "$out_c3" "NEVER STARTED" "Mode A loud warning text"

test_case "absent + SessionStart: stdout is valid JSON"
if echo "$out_c3" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "stdout failed jq parse — output was: $out_c3"
fi

test_case "absent + SessionStart: schema validates (hookEventName=SessionStart)"
event_in_output=$(echo "$out_c3" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "MISSING")
assert_eq "SessionStart" "$event_in_output" "hookSpecificOutput.hookEventName mirrors event"

test_case "absent + SessionStart: additionalContext is a string"
ctx_type=$(echo "$out_c3" | jq -r '.hookSpecificOutput.additionalContext | type' 2>/dev/null || echo "MISSING")
assert_eq "string" "$ctx_type" "additionalContext type"

test_case "absent + SessionStart: JSONL mode=A"
line=$(last_jsonl)
assert_contains "$line" '"mcp_alive":false' "JSONL mcp_alive false"
assert_contains "$line" '"mode":"A"' "JSONL mode A"

# ============================================================================
# Case 4 — Absent + UserPromptSubmit, same session as Case 3 (Mode A cross-fire)
# ============================================================================
test_case "absent + UPS same session as absent SS: stdout NEVER STARTED (Mode A)"
out_c4=$(run_hook '{"hook_event_name":"UserPromptSubmit","session_id":"sA"}')
assert_contains "$out_c4" "NEVER STARTED" "Mode A cross-fire keeps loud warning"

test_case "absent + UPS Mode A: schema validates (hookEventName=UserPromptSubmit)"
ev=$(echo "$out_c4" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "MISSING")
assert_eq "UserPromptSubmit" "$ev" "hookEventName mirrors event on UPS"

test_case "absent + UPS Mode A: JSONL mode=A"
line=$(last_jsonl)
assert_contains "$line" '"mode":"A"' "JSONL mode A on cross-fire"

# ============================================================================
# Case 5 — Absent + UserPromptSubmit, different session (Mode B)
# ============================================================================
test_case "Mode B setup: SessionStart with mcp_alive=true, session sB"
reset_state
start_mock_trajectory_server
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"sB","source":"startup"}')
assert_eq "" "$out" "healthy SessionStart silent"
stop_mock_trajectory_server

test_case "Mode B: UPS in different session_id sC, MCP absent"
out_c5=$(run_hook '{"hook_event_name":"UserPromptSubmit","session_id":"sC"}')
assert_contains "$out_c5" "no longer reachable" "Mode B warning text"

test_case "Mode B: stdout is valid JSON"
if echo "$out_c5" | jq . >/dev/null 2>&1; then
  _pass
else
  _fail "Mode B stdout failed jq parse — output was: $out_c5"
fi

test_case "Mode B: schema validates (hookEventName=UserPromptSubmit)"
ev=$(echo "$out_c5" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "MISSING")
assert_eq "UserPromptSubmit" "$ev" "Mode B hookEventName"

test_case "Mode B: JSONL mode=B"
line=$(last_jsonl)
assert_contains "$line" '"mode":"B"' "JSONL mode B"

# ============================================================================
# Case 6 — broader output-JSON-validity check (covered above via jq round-trip)
# ============================================================================
test_case "Cases 3-5 all produced parseable JSON"
ok="yes"
for out in "$out_c3" "$out_c4" "$out_c5"; do
  echo "$out" | jq . >/dev/null 2>&1 || ok="no"
done
assert_eq "yes" "$ok" "all Mode A/B outputs parse as JSON"

# ============================================================================
# Case 7 — schema validates against CC's documented hookEventName set
# ============================================================================
test_case "schema: hookEventName values are in {SessionStart, UserPromptSubmit}"
allowed_ok="yes"
for out in "$out_c3" "$out_c4" "$out_c5"; do
  ev=$(echo "$out" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "MISSING")
  case "$ev" in
    SessionStart|UserPromptSubmit) ;;
    *) allowed_ok="no" ;;
  esac
done
assert_eq "yes" "$allowed_ok" "every emission's hookEventName matches CC's allowed set"

# ============================================================================
# Case 8 — Unknown event name → no JSON emitted (guard fires)
# ============================================================================
test_case "unknown event + absent MCP: stdout empty (guard fires)"
reset_state
out_c8=$(run_hook '{"hook_event_name":"WeirdEvent","session_id":"sX"}')
assert_eq "" "$out_c8" "guard skips emission for unknown event"

test_case "unknown event: JSONL still written with event preserved"
line=$(last_jsonl)
assert_contains "$line" '"event":"WeirdEvent"' "JSONL preserves unknown event name"
assert_contains "$line" '"mcp_alive":false' "JSONL records MCP absent"

summarize
