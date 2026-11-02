#!/usr/bin/env bash
# An l3 suite points HOOK here, so its
# `bash "$HOOK"` calls run the TypeScript gate this file is named after.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
exec node "$PLUGIN_ROOT/mcp/trajectory-server/dist/hooks.js" "$(basename "${BASH_SOURCE[0]}" .sh)"
