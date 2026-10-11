#!/usr/bin/env bash
# Tests for scripts/lib/resolve-hook.sh — the headless-shim resolver.
#   - plain mode always runs the gate
#   - --shim runs the gate (stdin forwarded) when no plugin-hooks marker exists
#   - --shim yields when <project>/.claude/<plugin>/sessions/<sid>.plugin-hooks exists
#   - --shim yields (exit 0, gate not run) for a foreign CLAUDE_PROJECT_DIR
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
RESOLVER="$PLUGIN_ROOT/scripts/lib/resolve-hook.sh"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export CLAUDE_CONFIG_DIR="$TMP/claude"
VERSION_ROOT="$CLAUDE_CONFIG_DIR/plugins/cache/mp/tmb/1.0.0"
mkdir -p "$VERSION_ROOT/scripts/hooks" "$VERSION_ROOT/.claude-plugin"
printf '{"name":"tmb"}\n' > "$VERSION_ROOT/.claude-plugin/plugin.json"
FIRED="$TMP/fired.log"
cat > "$VERSION_ROOT/scripts/hooks/probe.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$(cat)" >> "$FIRED"
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"probe"}}'
EOF

PROJECT="$TMP/project"
mkdir -p "$PROJECT/.claude/tmb/sessions"
PAYLOAD='{"session_id":"sess-1","tool_name":"Bash"}'

fired_count() { [ -f "$FIRED" ] && wc -l < "$FIRED" | tr -d ' ' || echo 0; }

run() {
  printf '%s' "$PAYLOAD" | bash "$RESOLVER" "$@"
}

test_case "plain mode runs the gate"
unset CLAUDE_PROJECT_DIR
out=$(run --marketplace mp --hook probe)
assert_contains "$out" '"permissionDecision":"deny"' "gate decision forwarded"
assert_eq "1" "$(fired_count)" "gate ran once"

test_case "--shim without a session marker runs the gate with the payload"
out=$(run --marketplace mp --hook probe --shim --project "$PROJECT")
assert_contains "$out" '"permissionDecision":"deny"' "gate decision forwarded"
assert_eq "2" "$(fired_count)" "gate ran"
assert_contains "$(tail -1 "$FIRED")" '"session_id":"sess-1"' "stdin forwarded to the gate"

test_case "--shim with the plugin-hooks marker for this session yields"
: > "$PROJECT/.claude/tmb/sessions/sess-1.plugin-hooks"
rc=0
out=$(run --marketplace mp --hook probe --shim --project "$PROJECT") || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_eq "" "$out" "no decision"
assert_eq "2" "$(fired_count)" "gate not run"

test_case "--shim marker for another session does not yield"
PAYLOAD='{"session_id":"sess-2","tool_name":"Bash"}'
run --marketplace mp --hook probe --shim --project "$PROJECT" >/dev/null
assert_eq "3" "$(fired_count)" "gate ran for the headless session"

test_case "--shim yields for a foreign CLAUDE_PROJECT_DIR"
mkdir -p "$TMP/other"
rc=0
out=$(CLAUDE_PROJECT_DIR="$TMP/other" run --marketplace mp --hook probe --shim --project "$PROJECT") || rc=$?
assert_eq "0" "$rc" "exit 0"
assert_eq "" "$out" "no decision"
assert_eq "3" "$(fired_count)" "gate not run"

test_case "--shim with this project's CLAUDE_PROJECT_DIR and no marker runs the gate"
out=$(CLAUDE_PROJECT_DIR="$PROJECT" run --marketplace mp --hook probe --shim --project "$PROJECT")
assert_contains "$out" '"permissionDecision":"deny"' "gate decision forwarded"
assert_eq "4" "$(fired_count)" "gate ran"

summarize
