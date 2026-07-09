# scripts/lib

Shared shell helpers sourced by the top-level `scripts/` and by the hook engine. These are small, single-responsibility functions that several call sites need to resolve identically — keeping them here avoids each script re-implementing plugin-name resolution, a hook path, or an MCP-write fallback.

## Files

| File | Purpose |
|---|---|
| `resolve-plugin-name.sh` | Single source of truth for plugin-name resolution. Source it, then call `tmb_resolve_plugin_name` (reads the `name` field from `plugin.json`). |
| `resolve-hook.sh` | Version-agnostic hook resolver. Lets `/onboard` materialize a stable copy of a hook at a fixed path so version-pinned cache paths don't orphan it. |
| `sqlite3-fallback.sh` | `sqlite3` wrappers for the MCP write path, used when the MCP server is unavailable. Each wrapper validates the caller's role against the underlying MCP tool before writing. |
| `await-release-gate.sh` | Source it, then call `await_release_gate <tag> [timeout]` to poll the tag-triggered `release-gate` run via `gh` and return distinct codes for green / red / no-run / timeout. `publish-rc-channel.sh` and `release.sh` refuse to make a build public unless it concluded success. |

## How it fits

These helpers are sourced, not executed standalone. They underpin path resolution and the MCP-down recovery tier, so the same plugin-name lookup and write-fallback behavior holds whether a hook, a script, or a recovery flow invokes them.
