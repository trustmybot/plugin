# L0 — Install-smoke + Release canary

Install verification. L0 simulates what a fresh marketplace install does (build the payload → strip `node_modules` → cold-spawn the MCP server → `claude plugin install` → boot from the installed cache) so distribution regressions — missing `dist/`, absent postinstall build, server failing to boot — are caught before they reach a user. One driver holds the assertions and runs on macOS, Linux and Windows; release-gate runs it on all three. The Release canary builds its own image, then also runs the L5 doctrine flows against the marketplace-installed plugin (RC-only, token-heavy).

## Running install-smoke locally

Every run needs network (bun, npm and the embeddings model download).

| Host | Prerequisites | Command |
|---|---|---|
| Linux (or any host, in Docker) | Docker, node 22 | `node --experimental-strip-types tests/l0-install/run-docker.ts install` |
| macOS, Linux host-native | node 22, bun, the claude CLI (`npm install -g @anthropic-ai/claude-code`) | `node --experimental-strip-types tests/l0-install/install-smoke.ts` |
| Windows host-native | node 22, bun, the claude CLI (`npm install -g @anthropic-ai/claude-code`) | `node --experimental-strip-types tests\l0-install\install-smoke.ts` |

The host-native driver copies the plugin tree (no `node_modules`, `.git` or `.claude`) into a temp root, builds the payload there, and points `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and `CLAUDE_PLUGIN_DATA` at temp dirs, so your own `~/.claude` is never read or written. It removes the temp root on exit. Each failed assertion prints `FAIL <step>: ...` and exits 1. On Windows there is no data-dir bridge link, so steps A0d/A0e become one contract: the SessionStart hook installs `@huggingface/transformers` into the installed MCP dir, with no bridge link and nothing under `$CLAUDE_PLUGIN_DATA/deps/`.

| File | Purpose |
|---|---|
| [`install-smoke.ts`](./install-smoke.ts) | L0 driver — every install-smoke assertion (A0 cold boot, A0b `claude plugin install`, A0d/A0e embeddings start scenarios, A0c dependency install, A1–A4, A6, A3b, A3c, A7 legacy DB upgrade) on the host it runs on; `--prebuilt` reuses a built `dist/` |
| [`install-smoke.test.ts`](./install-smoke.test.ts) | `node:test` suite for the driver's step plan per platform, env isolation, installed-entry discovery, claude CLI resolution and the win32 deps contract; never runs claude, bun or Docker |
| [`install-smoke.Dockerfile`](./install-smoke.Dockerfile) | L0 Linux image — builds the payload, installs bun and the claude CLI, then runs `install-smoke.ts --prebuilt` |
| [`embeddings-data-dir-smoke.mjs`](./embeddings-data-dir-smoke.mjs) | Node MCP stdio driver for the two start scenarios (install-smoke steps A0d and A0e, GH 1748); both boot a copy of the plugin with no `node_modules`. `--scenario very-cold`: nothing installed anywhere — an empty `$CLAUDE_PLUGIN_DATA`, the server and the real `ensure-mcp-deps-installed` gate started together; embeddings must reach `ready` within 300 s, then `deps/<key>/` and the bridge link must exist. `--scenario cold`: a new plugin version with no bridge link while `$CLAUDE_PLUGIN_DATA/deps/<key>/` already holds transformers; embeddings must reach `ready` with no hook run, and `degraded` without the data dir |
| [`run-docker.ts`](./run-docker.ts) | Local runner, `node --experimental-strip-types tests/l0-install/run-docker.ts <mode>`, building from the plugin root: `install` builds the install-smoke image; `upgrade` runs `git archive v1.0.2` into a temp dir and builds the upgrade-smoke image with it as the `v102` build context; `canary` builds the canary image only without a token, the full L0+L5 run with `CLAUDE_CODE_OAUTH_TOKEN` |
| [`run-docker.test.ts`](./run-docker.test.ts) | `node:test` suite for the runner's docker argv and env per mode; never runs Docker |
| [`upgrade-smoke.Dockerfile`](./upgrade-smoke.Dockerfile) | Upgrade smoke — the shipped v1.0.2 server and hook write a real-shape DB (custom audit event type, verification waiver), the current server migrates it, and `cli.js trajectory-doctor` must exit 0 |
| [`upgrade-smoke-driver.mjs`](./upgrade-smoke-driver.mjs) | MCP stdio driver the upgrade-smoke image uses to seed the DB through v1.0.2 and boot the current server on it |
| [`release-canary.Dockerfile`](./release-canary.Dockerfile) | Install-smoke + full L5 doctrine flows against the marketplace artifact in one image |
