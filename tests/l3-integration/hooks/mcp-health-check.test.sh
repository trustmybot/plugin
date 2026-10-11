#!/usr/bin/env bash
# Tests for scripts/hooks/mcp-health-check.sh (SessionStart).
#   1. server present on the first sample        → silent, log mcp_alive=true
#   2. server appears on the third sample        → silent
#   3. server never appears                      → soft note, never "HALT"
#   4. legacy _tmb_managed groups in ~/.claude/settings.json → warning naming file + groups
#   5. settings.json without managed groups      → no warning
#   6. unknown event                             → no JSON
#   7. the forensic log lives in the project; nothing is written under HOME
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/mcp-health-check.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home"
mkdir -p "$HOME"
export HOME
unset CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR TRAJECTORY_DB_PATH
export TMB_MCP_HEALTH_INTERVAL_S=0.05

PROJECT="$TMP/project"
mkdir -p "$PROJECT/.claude/tmb"
sqlite3 "$PROJECT/.claude/tmb/trajectory.db" "CREATE TABLE tasks (id INTEGER PRIMARY KEY, prompt_bearing INTEGER);"
export CLAUDE_PROJECT_DIR="$PROJECT"
LOG_FILE="$PROJECT/.claude/tmb/logs/mcp-health.log"

# Stub pgrep: reports the server once the call count reaches $APPEAR_AT
# (0 = never). Counts calls in $CALLS.
STUB_DIR="$TMP/bin"
mkdir -p "$STUB_DIR"
CALLS="$TMP/pgrep.calls"
APPEAR="$TMP/appear-at"
cat > "$STUB_DIR/pgrep" <<EOF
#!/usr/bin/env bash
n=\$(( \$(cat "$CALLS" 2>/dev/null || echo 0) + 1 ))
echo "\$n" > "$CALLS"
at=\$(cat "$APPEAR" 2>/dev/null || echo 0)
if [ "\$at" -gt 0 ] && [ "\$n" -ge "\$at" ]; then echo 99999; exit 0; fi
exit 1
EOF
chmod +x "$STUB_DIR/pgrep"
export PATH="$STUB_DIR:$PATH"

reset() { rm -f "$CALLS"; echo "$1" > "$APPEAR"; }
run_hook() { printf '%s' "$1" | bash "$HOOK" 2>/dev/null || true; }
SS='{"hook_event_name":"SessionStart","session_id":"s-1"}'

test_case "server present on the first sample: silent"
reset 1
out=$(run_hook "$SS")
assert_eq "" "$out" "no output"
assert_eq "1" "$(cat "$CALLS")" "one sample taken"
assert_eq "true" "$(tail -1 "$LOG_FILE" | jq -r '.mcp_alive')" "log mcp_alive=true"

test_case "server appears on the third sample: silent"
reset 3
out=$(run_hook "$SS")
assert_eq "" "$out" "no output"
assert_eq "3" "$(cat "$CALLS")" "three samples taken"

test_case "server never appears: soft note, no HALT"
reset 0
out=$(run_hook "$SS")
assert_eq "3" "$(cat "$CALLS")" "three samples taken"
assert_eq "SessionStart" "$(printf '%s' "$out" | jq -r '.hookSpecificOutput.hookEventName')" "valid SessionStart output"
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "$ctx" "trajectory-server not detected yet at SessionStart" "soft note"
assert_contains "$ctx" "tmb_recovery §C" "points at the recovery doctrine"
assert_not_contains "$out" "HALT" "never HALTs from a pgrep sample"
assert_not_contains "$out" "rm -rf" "no destructive recipe"
assert_eq "false" "$(tail -1 "$LOG_FILE" | jq -r '.mcp_alive')" "log mcp_alive=false"

test_case "legacy _tmb_managed groups in ~/.claude/settings.json: warning names file and groups"
reset 1
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" <<'EOF'
{"hooks":{"PreToolUse":[
  {"matcher":"Bash","hooks":[{"type":"command","command":"bash /h/.claude/tmb-hooks/resolve-hook.sh --marketplace trustmybot --hook git-guards","_tmb_managed":true}]},
  {"matcher":"Edit|Write","hooks":[{"type":"command","command":"/usr/local/bin/mine.sh"}]}
]}}
EOF
out=$(run_hook "$SS")
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "$ctx" "$HOME/.claude/settings.json" "names the file"
assert_contains "$ctx" "PreToolUse Bash" "names the managed group"
assert_not_contains "$ctx" "Edit|Write" "user group not listed"
assert_contains "$ctx" "_tmb_managed" "offers the cleanup"
assert_not_contains "$out" "HALT" "no HALT"

test_case "settings.json without managed groups: no warning"
echo '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/mine.sh"}]}]}}' > "$HOME/.claude/settings.json"
out=$(run_hook "$SS")
assert_eq "" "$out" "silent"
rm -rf "$HOME/.claude"

test_case "unknown event: no JSON"
reset 0
out=$(run_hook '{"session_id":"s-2"}')
assert_eq "" "$out" "no output"

test_case "nothing written under HOME"
assert_eq "" "$(find "$HOME" -mindepth 1 -print)" "HOME untouched"
assert_eq "yes" "$([ -s "$LOG_FILE" ] && echo yes || echo no)" "log is project-local"

summarize
