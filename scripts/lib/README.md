# scripts/lib

Shell helpers for the release flow. The headless hook shim's resolver is TypeScript, `mcp/trajectory-server/src/hooks/resolve-hook.ts`, bundled to `dist/resolve-hook.mjs`. The hook engine's own shared helpers — trajectory-DB location, reads and writes, timestamps, task resolution, repo policy, command analysis — live in [`scripts/hooks/lib/`](../hooks/lib/).

## Files

| File | Purpose |
|---|---|
| `await-release-gate.sh` | Source it, then call `resolve_gate_tag <tag> [repo_dir]` to map the target tag to the tag whose run carries the verdict (rc tags pass through; a stable tag resolves to the newest rc tag in HEAD's ancestry), and `await_release_gate <tag> [repo_dir] [timeout]` to poll that run via `gh` and return distinct codes for green / red / no-run / timeout. Both run git with `-C <repo_dir>` (default: the checkout holding the file), never in the cwd. `publish-rc-channel.sh` and `release.sh` refuse to make a build public unless it concluded success. |

## How it fits

`await-release-gate.sh` is sourced by the release scripts.
