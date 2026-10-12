# scripts/lib

Shell helpers sourced by the top-level `scripts/` (release flow, MCP-down recovery) and by a few hooks that need the same answer as those scripts. The hook engine's own shared helpers — trajectory-DB location, reads and writes, timestamps, task resolution, repo policy, command analysis — live in [`scripts/hooks/lib/`](../hooks/lib/); the helpers here build on them rather than re-implementing them.

## Files

| File | Purpose |
|---|---|
| `resolve-plugin-name.sh` | Source it, then call `tmb_resolve_plugin_name` (reads the `name` field from `plugin.json`, else `tmb`). Hooks that already source `scripts/hooks/lib/query-task.sh` use its `tmb_plugin_name` instead. |
| `resolve-hook.sh` | The project-scoped headless shim. `/onboard` materializes a copy at `<project>/.claude/<plugin>/resolve-hook.sh`; at hook-fire time it finds the active TMB install and execs that install's `scripts/hooks/dispatch.sh <gate> --shim`, with `TMB_SHIM_PROJECT` set to the project's physical path (`cd -P`), so plugin upgrades never orphan the registered hook paths. |
| `sqlite3-fallback.sh` | `sqlite3` wrappers for the MCP write path, used when the MCP server is unavailable. Each wrapper validates the caller's role against the underlying MCP tool (and `tmb_fallback_audit_append` its `event_type` against the first column of `scripts/hooks/lib/audit-events.txt`, refusing the write when the file is missing), then writes through `tmb_db_write` (`scripts/hooks/lib/db-write.sh`) with an audit row in the same transaction. |
| `await-release-gate.sh` | Source it, then call `resolve_gate_tag()` to map the target tag to the tag whose run carries the verdict (rc tags pass through; a stable tag resolves to the newest rc tag in HEAD's ancestry), and `await_release_gate <tag> [timeout]` to poll that run via `gh` and return distinct codes for green / red / no-run / timeout. `publish-rc-channel.sh` and `release.sh` refuse to make a build public unless it concluded success. |

## How it fits

These helpers are sourced, not executed standalone (`resolve-hook.sh` is the exception: the shim runs it as a command). The DB path, write path and timestamp format they use come from `scripts/hooks/lib/`, so a hook, a script and a recovery flow resolve and write the trajectory DB identically.
