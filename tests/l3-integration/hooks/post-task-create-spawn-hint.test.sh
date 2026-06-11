#!/usr/bin/env bash
# Tests for scripts/hooks/post-task-create-spawn-hint.sh
# PostToolUse hook on task_create_batch. Injects additionalContext reminding
# bro to spawn SWE after tasks are created. Tests focus on:
# - bypass env var
# - non-matching tool passes silently
# - error response passes silently
# - correct tool_response.content[0].text parsing
# - valid task list emits hint
# - empty task list passes silently
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/post-task-create-spawn-hint.sh"

run_hook() {
  echo "$1" | bash "$HOOK" 2>&1 || true
}

make_input() {
  local tool_name="$1"
  local response_text="$2"
  local is_error="${3:-false}"
  jq -nc \
    --arg tn "$tool_name" \
    --arg rt "$response_text" \
    --argjson ie "$is_error" \
    '{
      tool_name: $tn,
      tool_response: {
        is_error: $ie,
        content: [{ type: "text", text: $rt }]
      }
    }'
}

TASK_ARRAY='[{"id":42,"branch_id":"feat/my-feature"},{"id":43,"branch_id":"feat/other"}]'

# ──────────────────────────────────────────────────────────────
# Case 1: bypass env var exits silently
# ──────────────────────────────────────────────────────────────
test_case "TMB_DISABLE_SPAWN_HINT=1 exits silently"
input=$(make_input "mcp__tmb__trajectory-server__task_create_batch" "$TASK_ARRAY")
out=$(echo "$input" | TMB_DISABLE_SPAWN_HINT=1 bash "$HOOK" 2>&1 || true)
assert_eq "" "$out" "bypass env var produces no output"

# ──────────────────────────────────────────────────────────────
# Case 2: non-matching tool name exits silently
# ──────────────────────────────────────────────────────────────
test_case "non-matching tool_name exits silently"
input=$(make_input "Bash" "$TASK_ARRAY")
out=$(run_hook "$input")
assert_eq "" "$out" "Bash tool produces no output"

test_case "task_update_status tool exits silently"
input=$(make_input "mcp__tmb__trajectory-server__task_update_status" "$TASK_ARRAY")
out=$(run_hook "$input")
assert_eq "" "$out" "task_update_status produces no output"

# ──────────────────────────────────────────────────────────────
# Case 3: error response passes silently
# ──────────────────────────────────────────────────────────────
test_case "is_error=true exits silently"
input=$(make_input "mcp__tmb__trajectory-server__task_create_batch" "$TASK_ARRAY" "true")
out=$(run_hook "$input")
assert_eq "" "$out" "error response produces no output"

# ──────────────────────────────────────────────────────────────
# Case 4: valid task array in content[0].text emits hint
# ──────────────────────────────────────────────────────────────
test_case "valid task array emits SWE-spawn hint"
input=$(make_input "mcp__tmb__trajectory-server__task_create_batch" "$TASK_ARRAY")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "hook emits additionalContext"
assert_contains "$out" "SWE-spawn hint" "hint mentions SWE-spawn"
assert_contains "$out" "task_id=42" "hint lists task id 42"
assert_contains "$out" "task_id=43" "hint lists task id 43"
assert_contains "$out" "branch_id=feat/my-feature" "hint lists branch_id"
assert_contains "$out" "Step 4" "hint cites tmb_planning Step 4"

# ──────────────────────────────────────────────────────────────
# Case 4b: absolute worktree path derived from trajectory DB location
# ──────────────────────────────────────────────────────────────
test_case "worktree path is absolute and starts with workspace root"
FIXTURE_WS="$(mktemp -d)"
FIXTURE_DB_DIR="$FIXTURE_WS/.claude/tmb"
mkdir -p "$FIXTURE_DB_DIR"
touch "$FIXTURE_DB_DIR/trajectory.db"
input=$(make_input "mcp__tmb__trajectory-server__task_create_batch" "$TASK_ARRAY")
out=$(echo "$input" | TRAJECTORY_DB_PATH="$FIXTURE_DB_DIR/trajectory.db" bash "$HOOK" 2>&1 || true)
assert_contains "$out" "$FIXTURE_WS/.claude/worktrees/" "emitted path starts with fixture workspace root"
assert_contains "$out" "worktree=$FIXTURE_WS/.claude/worktrees/my-feature" "slug strips type/ prefix for feat/my-feature"
rm -rf "$FIXTURE_WS"

# ──────────────────────────────────────────────────────────────
# Case 5: response text is non-array JSON — passes silently
# ──────────────────────────────────────────────────────────────
test_case "non-array response text exits silently"
input=$(make_input "mcp__tmb__trajectory-server__task_create_batch" '{"error":"something"}')
out=$(run_hook "$input")
assert_eq "" "$out" "non-array response text produces no output"

# ──────────────────────────────────────────────────────────────
# Case 6: empty array response — passes silently (no tasks to list)
# ──────────────────────────────────────────────────────────────
test_case "empty task array exits silently"
input=$(make_input "mcp__tmb__trajectory-server__task_create_batch" '[]')
out=$(run_hook "$input")
assert_eq "" "$out" "empty task array produces no output"

# ──────────────────────────────────────────────────────────────
# Case 7: hint output has correct JSON structure
# ──────────────────────────────────────────────────────────────
test_case "hint output is valid JSON with hookEventName=PostToolUse"
input=$(make_input "mcp__tmb__trajectory-server__task_create_batch" "$TASK_ARRAY")
out=$(run_hook "$input")
event=$(echo "$out" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null || echo "")
assert_eq "PostToolUse" "$event" "hookEventName is PostToolUse"

# ──────────────────────────────────────────────────────────────
# Case 8: plugin-namespaced tool name variant also matches
# ──────────────────────────────────────────────────────────────
test_case "plugin-prefixed tool name variant triggers hint"
input=$(make_input "mcp__plugin_tmb_trajectory-server__task_create_batch" "$TASK_ARRAY")
out=$(run_hook "$input")
assert_contains "$out" "additionalContext" "plugin-prefixed tool name triggers hint"

summarize
