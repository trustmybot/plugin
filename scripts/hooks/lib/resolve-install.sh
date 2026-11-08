#!/usr/bin/env bash
# Shim: the plugin name for the codex-owned L5/L6 shell harness
# (tests/l5-l6/lib/flow-helpers.sh). Sourced (not exec'd); it sets no shell
# options. It exists only for those callers and is a removal candidate once
# codex PRs 1183, 2159 and 2162-2166 land. The install readers live in
# mcp/trajectory-server/src/hooks/lib/install.ts; this shim asks dist/cli.js.

# _tmb_install_plugin_name: CLAUDE_PLUGIN_ROOT's manifest name, else the installPluginName default.
_tmb_install_plugin_name() {
  local root
  root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P) || return 1
  node --experimental-sqlite "$root/mcp/trajectory-server/dist/cli.js" hook-lib install-plugin-name
}
