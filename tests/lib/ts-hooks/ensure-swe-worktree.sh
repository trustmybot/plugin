#!/usr/bin/env bash
# Under TMB_HOOK_TEST_IMPL=ts an l3 suite points HOOK here, so its
# `bash "$HOOK"` calls run the TypeScript ensure-swe-worktree gate. The suite may point
# HOME at a sandbox it checks stays empty, so this file runs the node binary the
# suite exports as TMB_TEST_NODE rather than a version-manager shim that writes
# state under HOME.
exec "${TMB_TEST_NODE:-node}" "${BASH_SOURCE[0]%/*}/../../../mcp/trajectory-server/dist/hooks.js" ensure-swe-worktree
