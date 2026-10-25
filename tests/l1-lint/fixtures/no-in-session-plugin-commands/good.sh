#!/usr/bin/env bash
# shellcheck disable=SC2034,SC2154,SC2164
WORKDIR /plugin
COPY . /plugin
cd /plugin && bun install
UPDATE_CMD="claude plugin update $INSTALL_KEY --scope $INSTALL_SCOPE"
SERVER_LOG="$(dirname "$DB")/logs/mcp-server.log"
_pat="${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js"
[ "$(basename "$PWD")" = plugin ] && echo "/plugin.json missing"
