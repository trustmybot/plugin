# scripts/maintenance

Operational and one-off scripts that keep a TMB install healthy: version bumps, cache remediation, stale-worktree cleanup, and the standalone scan invokers fired by hooks. These are not part of the per-turn hot path — they run on demand (a person, a release flow) or as the body a hook shells out to.

## Files

| File | Purpose |
|---|---|
| `bump-version.sh` | Atomic plugin-version bump — updates the three manifests that must stay in sync, or fails leaving every file unchanged. Idempotent. |
| `heal-mcp-cache.sh` | Interactive remediation for the Claude Code plugin MCP-config cache bug — clears stale `disabledMcpServers` entries and other recovery steps. |
| `cleanup-stale-worktrees.sh` | One-time cleanup of repo-rooted SWE worktrees left over before worktrees moved to workspace-rooted paths. Idempotent. |
| `run-scan.mjs` | Standalone scan invoker used by the `post-task-close-rescan.sh` hook to re-run the scan against the current commit after an atomic close. Reuses the same `scan_run` logic as the MCP tool; silent on failure. |
| `run-scan-initial.mjs` | Mirror of `run-scan.mjs` for the cold-world-model SessionStart prescan, tagged with a distinct audit source. Silent on failure. |

## How it fits

`bump-version.sh` backs the release/version-sync flow; `heal-mcp-cache.sh` and `cleanup-stale-worktrees.sh` are recovery tooling; the two `run-scan*.mjs` invokers let hooks refresh the world model without duplicating the MCP tool's scan logic.
