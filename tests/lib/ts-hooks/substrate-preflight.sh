#!/usr/bin/env bash
# Under TMB_HOOK_TEST_IMPL=ts an l3 suite points HOOK here, so its
# `bash "$HOOK"` calls run the TypeScript substrate-preflight gate. The suite
# runs it with a PATH that may lack dirname, basename and node, so this file
# uses only parameter expansion and the node the suite exports as TMB_TEST_NODE.
exec "${TMB_TEST_NODE:-node}" "${BASH_SOURCE[0]%/*}/../../../mcp/trajectory-server/dist/hooks.js" substrate-preflight
