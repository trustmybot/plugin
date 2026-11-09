# scripts/lib

TypeScript helpers for the release flow. The headless hook shim's resolver is TypeScript, `mcp/trajectory-server/src/hooks/resolve-hook.ts`, bundled to `dist/resolve-hook.mjs`. The hook engine's own shared helpers — trajectory-DB location, reads and writes, timestamps, task resolution, repo policy, command analysis — live in [`mcp/trajectory-server/src/hooks/lib/`](../../mcp/trajectory-server/src/hooks/lib/).

## Files

| File | Purpose |
|---|---|
| `await-release-gate.ts` | Import `resolveGateTag(tag, repoDir?)` to map the target tag to the tag whose run carries the verdict (rc tags pass through; a stable tag resolves to the newest rc tag in HEAD's ancestry), and `awaitReleaseGate(tag, repoDir?, timeoutS?)` to poll that run via `gh` and return distinct codes for green / red / no-run / timeout. Both run git with `-C <repoDir>` (default: the checkout holding the file), never in the cwd. `publish-rc-channel.ts` and `release.ts` refuse to make a build public unless it concluded success. |

## How it fits

`await-release-gate.ts` is imported by the release scripts, which run as `node --experimental-strip-types scripts/release.ts` and `node --experimental-strip-types scripts/publish-rc-channel.ts`.
