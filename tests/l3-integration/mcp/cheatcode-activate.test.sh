#!/usr/bin/env bash
# L3: cheatcode activate / hot-load stage (#660).
#   cheatcode_activate has no forked script — it inspects the install record's
#   kind and returns a deterministic verdict. This drives the REAL MCP server
#   over the wire (via the shared harness): install a cheatcode, activate it,
#   assert the verdict branch. Skill → activated; plugin/mcp → restart_required.
# Network is stubbed via TMB_CHEATCODE_INSTALL_FIXTURE — no live web.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../../.." && pwd)"
SERVER_DIST="$PLUGIN_ROOT/mcp/trajectory-server/dist/index.js"

command -v node >/dev/null 2>&1 || { printf "SKIP node not found\n"; exit 0; }
if [ ! -f "$SERVER_DIST" ]; then
  (cd "$PLUGIN_ROOT/mcp/trajectory-server" && bun run build >/dev/null 2>&1) || {
    printf "SKIP could not build MCP server\n"; exit 0;
  }
fi

WORKSPACE=$(mktemp -d)
trap 'rm -rf "$WORKSPACE"' EXIT

FIXTURE="$WORKSPACE/install.json"
cat > "$FIXTURE" <<'JSON'
{ "installed": true, "version": "1.2.3", "error": null }
JSON
export TMB_CHEATCODE_INSTALL_FIXTURE="$FIXTURE"

# Drive the real server: install (plugin + skill), activate each, print the two
# verdicts as a single JSON line for the bash assertions below.
RESULT=$(node --input-type=module <<NODE
import { startClient, call } from '${HERE}/harness.mjs';

const { client, close } = await startClient();
try {
  const plugin = await call(client, 'cheatcode_install', {
    agent: 'bro',
    candidate: { name: 'pdf-plugin', kind: 'plugin', source_url: 'https://x.test/pdf', tier: 1 },
  });
  if (!plugin.ok) throw new Error('plugin install failed: ' + JSON.stringify(plugin));
  const pluginId = plugin.data.cheatcode_id;

  const skill = await call(client, 'cheatcode_install', {
    agent: 'bro',
    candidate: { name: 'pdf-skill', kind: 'skill', source_url: 'https://x.test/pdf-skill' },
  });
  if (!skill.ok) throw new Error('skill install failed: ' + JSON.stringify(skill));
  const skillId = skill.data.cheatcode_id;

  const pluginVerdict = await call(client, 'cheatcode_activate', { agent: 'bro', cheatcode_id: pluginId });
  const skillVerdict = await call(client, 'cheatcode_activate', { agent: 'bro', cheatcode_id: skillId });
  const unknown = await call(client, 'cheatcode_activate', { agent: 'bro', cheatcode_id: 99999 });
  const forbidden = await call(client, 'cheatcode_activate', { agent: 'swe', cheatcode_id: pluginId });

  process.stdout.write(JSON.stringify({
    plugin: pluginVerdict,
    skill: skillVerdict,
    unknown,
    forbidden,
  }));
} finally {
  await close();
}
NODE
)

command -v jq >/dev/null 2>&1 || { printf "SKIP jq not found\n"; exit 0; }

test_case "activate output is valid JSON"
if printf '%s' "$RESULT" | jq -e . >/dev/null 2>&1; then _pass; else _fail "not JSON: $RESULT"; fi

test_case "plugin-kind activate returns restart_required"
assert_eq "true" "$(printf '%s' "$RESULT" | jq -r '.plugin.ok')" "plugin call ok"
assert_eq "restart_required" "$(printf '%s' "$RESULT" | jq -r '.plugin.data.status')" "plugin status"

test_case "plugin-kind restart_required carries a non-empty reason"
REASON=$(printf '%s' "$RESULT" | jq -r '.plugin.data.reason')
if [ -n "$REASON" ] && [ "$REASON" != "null" ]; then _pass; else _fail "empty reason: $REASON"; fi

test_case "skill-kind activate returns activated"
assert_eq "true" "$(printf '%s' "$RESULT" | jq -r '.skill.ok')" "skill call ok"
assert_eq "activated" "$(printf '%s' "$RESULT" | jq -r '.skill.data.status')" "skill status"

test_case "unknown cheatcode_id is an error (never silently throws)"
assert_eq "false" "$(printf '%s' "$RESULT" | jq -r '.unknown.ok')" "unknown is error"

test_case "non-bro caller is forbidden at the wire"
assert_eq "false" "$(printf '%s' "$RESULT" | jq -r '.forbidden.ok')" "forbidden"
assert_eq "forbidden" "$(printf '%s' "$RESULT" | jq -r '.forbidden.error.error')" "forbidden error"

summarize
printf "PASS cheatcode-activate\n"
