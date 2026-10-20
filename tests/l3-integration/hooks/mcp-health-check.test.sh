#!/usr/bin/env bash
# Tests for scripts/hooks/mcp-health-check.sh (SessionStart).
#   1. server present on the first sample        → silent, log mcp_alive=true
#   2. server appears on the third sample        → silent
#   3. server never appears                      → soft note, never "HALT"
#   4. leftover TMB hooks in ~/.claude/settings.json → no warning here (the
#      prescan and health.sh report them); the file is left byte-identical
#   5. settings.json without leftover hooks      → no warning
#   6. unknown event                             → no JSON
#   7. the forensic log lives in the project; nothing is written under HOME
#   8. install notices from installed_plugins.json, once per session:
#      user + project → "user-scope ... ignored"; user only → "--scope project"
#      recommended; project only → silent
#   9. duplicate enabled copies (installed_plugins.json + settings.local.json):
#      one enabled → silent; two enabled for this project → warning naming both;
#      two installed, one disabled → silent; user + project entry of one
#      marketplace → no duplicate warning; unreadable files → silent, no error
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/mcp-health-check.sh"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/tmb-mcp-health-check.XXXXXX")
trap 'rm -rf "$TMP"' EXIT
HOME="$TMP/home"
mkdir -p "$HOME"
export HOME
unset CLAUDE_PLUGIN_ROOT CLAUDE_CONFIG_DIR TRAJECTORY_DB_PATH
export TMB_MCP_HEALTH_INTERVAL_S=0.05
export TMB_INSTALLED_JSON="$TMP/installed_plugins.json"

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

test_case "leftover TMB hooks in ~/.claude/settings.json: no warning here; file unchanged"
reset 1
mkdir -p "$HOME/.claude"
cp "$HERE/fixtures/legacy-user-settings.json" "$HOME/.claude/settings.json"
out=$(run_hook "$SS")
assert_eq "" "$out" "silent"
assert_not_contains "$out" "settings.json" "no leftover-hook warning"
cmp "$HERE/fixtures/legacy-user-settings.json" "$HOME/.claude/settings.json" >/dev/null && same=yes || same=no
assert_eq "yes" "$same" "settings.json byte-identical"

test_case "settings.json without leftover hooks: no warning"
echo '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/usr/local/bin/mine.sh"}]}]}}' > "$HOME/.claude/settings.json"
out=$(run_hook "$SS")
assert_eq "" "$out" "silent"
rm -rf "$HOME/.claude"

USER_INSTALL="$TMP/cache/mp/tmb/1.0.1"
PROJECT_INSTALL="$TMP/cache/mp-dev/tmb/1.0.3"
mkdir -p "$USER_INSTALL" "$PROJECT_INSTALL"
user_entry() { printf '{"scope":"user","installPath":"%s","installedAt":"2026-01-01T00:00:00.000Z","version":"1.0.1"}' "$USER_INSTALL"; }
project_entry() { printf '{"scope":"local","projectPath":"%s","installPath":"%s","installedAt":"2026-02-01T00:00:00.000Z","version":"1.0.3"}' "$PROJECT" "$PROJECT_INSTALL"; }

test_case "user + project installs: user-scope install named as ignored, once per session"
reset 1
printf '{"version":2,"plugins":{"tmb@mp":[%s],"tmb@mp-dev":[%s]}}\n' "$(user_entry)" "$(project_entry)" > "$TMB_INSTALLED_JSON"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"inst-1"}')
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "$ctx" "user-scope TMB v1.0.1 ignored — project install v1.0.3 in use" "names both versions"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"inst-1"}')
assert_eq "" "$out" "second SessionStart in the same session is silent"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"inst-2"}')
assert_contains "$out" "ignored" "a new session gets the notice"

test_case "user-scope install only: --scope project recommended"
reset 1
printf '{"version":2,"plugins":{"tmb@mp":[%s]}}\n' "$(user_entry)" > "$TMB_INSTALLED_JSON"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"inst-3"}')
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "$ctx" "TMB installed at user scope; \`--scope project\` is recommended (see docs/reference/INSTALL.md)" "recommendation"

test_case "user-scope install only: notice names the plugin-root INSTALL.md"
out=$(CLAUDE_PLUGIN_ROOT="$TMP/plugin-root" run_hook '{"hook_event_name":"SessionStart","session_id":"inst-3b"}')
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "$ctx" "(see $TMP/plugin-root/docs/reference/INSTALL.md)" "plugin-root path"

test_case "project install only: no notice"
reset 1
printf '{"version":2,"plugins":{"tmb@mp-dev":[%s]}}\n' "$(project_entry)" > "$TMB_INSTALLED_JSON"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"inst-4"}')
assert_eq "" "$out" "silent"
rm -f "$TMB_INSTALLED_JSON"

LOCAL_SETTINGS="$PROJECT/.claude/settings.local.json"
local_entry() { printf '{"scope":"local","projectPath":"%s","installPath":"%s/cache/%s/tmb/%s","version":"%s"}' "$PROJECT" "$TMP" "$1" "$2" "$2"; }
two_local_installs() {
  printf '{"version":2,"plugins":{"tmb@trustmybot-dev":[%s],"tmb@trustmybot-rc":[%s]}}\n' \
    "$(local_entry trustmybot-dev 1.0.3)" "$(local_entry trustmybot-rc 1.0.2-rc.3)" > "$TMB_INSTALLED_JSON"
}

test_case "duplicate copies: one enabled copy is silent"
reset 1
printf '{"version":2,"plugins":{"tmb@trustmybot-dev":[%s]}}\n' "$(local_entry trustmybot-dev 1.0.3)" > "$TMB_INSTALLED_JSON"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true}}' > "$LOCAL_SETTINGS"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"dup-1"}')
assert_eq "" "$out" "silent"

test_case "duplicate copies: two enabled for this project warn, naming both and the remedy"
reset 1
two_local_installs
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}' > "$LOCAL_SETTINGS"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"dup-2"}')
ctx=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "$ctx" "2 copies of the tmb plugin are enabled for this project (trustmybot-dev@1.0.3, trustmybot-rc@1.0.2-rc.3)" "names both copies"
assert_contains "$ctx" "registers the hooks of only one of them" "names the failure mode"
assert_contains "$ctx" "run /plugin and disable the extra copy" "names the remedy"

test_case "duplicate copies: two installed, one disabled is silent"
reset 1
two_local_installs
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":false}}' > "$LOCAL_SETTINGS"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"dup-3"}')
assert_eq "" "$out" "silent"

test_case "duplicate copies: a user and a project entry of one marketplace are one copy"
reset 1
printf '{"version":2,"plugins":{"tmb@mp-dev":[%s,%s]}}\n' "$(user_entry)" "$(project_entry)" > "$TMB_INSTALLED_JSON"
echo '{"enabledPlugins":{"tmb@mp-dev":true}}' > "$LOCAL_SETTINGS"
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"dup-4"}')
assert_not_contains "$out" "copies of the tmb plugin" "no duplicate warning"

test_case "duplicate copies: unreadable files are silent, with no error"
reset 1
two_local_installs
echo '{"enabledPlugins":' > "$LOCAL_SETTINGS"
err=$(printf '%s' '{"hook_event_name":"SessionStart","session_id":"dup-5"}' | bash "$HOOK" 2>&1 >/dev/null || true)
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"dup-6"}')
assert_eq "" "$out" "invalid settings.local.json: silent"
assert_eq "" "$err" "invalid settings.local.json: no stderr"
echo '{"enabledPlugins":{"tmb@trustmybot-dev":true,"tmb@trustmybot-rc":true}}' > "$LOCAL_SETTINGS"
chmod 000 "$TMB_INSTALLED_JSON"
err=$(printf '%s' '{"hook_event_name":"SessionStart","session_id":"dup-7"}' | bash "$HOOK" 2>&1 >/dev/null || true)
out=$(run_hook '{"hook_event_name":"SessionStart","session_id":"dup-8"}')
assert_eq "" "$out" "unreadable installed_plugins.json: silent"
assert_eq "" "$err" "unreadable installed_plugins.json: no stderr"
chmod 600 "$TMB_INSTALLED_JSON"
rm -f "$TMB_INSTALLED_JSON" "$LOCAL_SETTINGS"

test_case "unknown event: no JSON"
reset 0
out=$(run_hook '{"session_id":"s-2"}')
assert_eq "" "$out" "no output"

test_case "nothing written under HOME"
assert_eq "" "$(find "$HOME" -mindepth 1 -print)" "HOME untouched"
assert_eq "yes" "$([ -s "$LOG_FILE" ] && echo yes || echo no)" "log is project-local"

summarize
