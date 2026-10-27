#!/usr/bin/env bash
# Under TMB_HOOK_TEST_IMPL=ts an l3 suite points HOOK here, so its
# `bash "$HOOK"` calls run the TypeScript session-start-prescan gate, with the
# node binary the suite exports as TMB_TEST_NODE.
exec "${TMB_TEST_NODE:-node}" "${BASH_SOURCE[0]%/*}/../../../mcp/trajectory-server/dist/hooks.js" session-start-prescan
