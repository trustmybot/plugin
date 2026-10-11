#!/usr/bin/env bash
# Live Claude Code proof for the facts the footprint design rests on. Opt-in:
# runs only with TMB_L3_LIVE_CC=1, a `claude` CLI and CLAUDE_CODE_OAUTH_TOKEN
# (a real, billed haiku run); otherwise it reports SKIP and passes.
#
# In a sandbox project under a temp HOME, one `claude -p` run spawns a
# subagent that runs Bash. Hooks are registered twice — in the project's
# .claude/settings.local.json and in a --plugin-dir plugin's hooks.json — and
# each fire records its event, session_id and CLAUDE_PROJECT_DIR. Asserts:
#   1. a project settings.local.json PreToolUse hook fires under `claude -p`
#   2. CLAUDE_PROJECT_DIR is the project root in every hook, including the
#      subagent's PreToolUse and SubagentStop (so no $HOME sentinel is needed)
#   3. the subagent's tool calls carry the main session_id (so the
#      per-session plugin-hooks marker covers subagent gates too)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/../../lib/assert.sh"

if [ "${TMB_L3_LIVE_CC:-0}" != "1" ] || ! command -v claude >/dev/null 2>&1 || [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "SKIP live-cc-hook-env (set TMB_L3_LIVE_CC=1 with claude + CLAUDE_CODE_OAUTH_TOKEN to run)"
  exit 0
fi

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/proj/.claude" "$T/plug/.claude-plugin" "$T/plug/hooks"
PROJ=$(cd "$T/proj" && pwd -P)
LOG="$T/fired.jsonl"

cat > "$T/dump.sh" <<EOF
#!/usr/bin/env bash
payload=\$(cat)
jq -nc --arg src "\$1" --arg cpd "\${CLAUDE_PROJECT_DIR-<unset>}" --argjson p "\$payload" \
  '{src:\$src, event:\$p.hook_event_name, tool:(\$p.tool_name // null), agent_id:(\$p.agent_id // null), session_id:\$p.session_id, cpd:\$cpd}' >> "$LOG"
exit 0
EOF

hook() { printf '{"type":"command","command":"bash %s %s"}' "$T/dump.sh" "$1"; }
events() {
  printf '{"hooks":{"SessionStart":[{"hooks":[%s]}],"PreToolUse":[{"matcher":"*","hooks":[%s]}],"SubagentStop":[{"hooks":[%s]}]}}\n' \
    "$(hook "$1")" "$(hook "$1")" "$(hook "$1")"
}
events settings > "$PROJ/.claude/settings.local.json"
printf '{"name":"cc-hook-env-proof","version":"0.0.1"}\n' > "$T/plug/.claude-plugin/plugin.json"
events plugin > "$T/plug/hooks/hooks.json"

(cd "$PROJ" && env -i PATH="$PATH" HOME="$T/home" CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_CODE_OAUTH_TOKEN" TERM=dumb \
  claude -p "Use the Agent tool exactly once to spawn a general-purpose subagent whose only job is to run the bash command: cd / && echo hi . Then reply DONE." \
  --model haiku --plugin-dir "$T/plug" --permission-mode bypassPermissions --max-turns 6 </dev/null >/dev/null 2>&1)

test_case "project settings.local.json PreToolUse fires under claude -p"
assert_eq "true" "$(jq -s '[.[] | select(.src=="settings" and .event=="PreToolUse")] | length > 0' "$LOG" 2>/dev/null)" "settings.local.json hook fired"

test_case "CLAUDE_PROJECT_DIR reaches subagent PreToolUse and SubagentStop hooks"
assert_eq "true" "$(jq -s '[.[] | select(.event=="PreToolUse" and .agent_id != null)] | length > 0' "$LOG")" "subagent tool call observed"
assert_eq "true" "$(jq -s '[.[] | select(.event=="SubagentStop")] | length > 0' "$LOG")" "SubagentStop observed"
assert_eq "0" "$(jq -s --arg p "$PROJ" '[.[] | select(.cpd != $p)] | length' "$LOG")" "every hook saw CLAUDE_PROJECT_DIR=$PROJ"

test_case "subagent hooks carry the main session_id"
assert_eq "1" "$(jq -s '[.[].session_id] | unique | length' "$LOG")" "one session_id across main and subagent hooks"

summarize
