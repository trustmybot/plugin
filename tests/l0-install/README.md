# L0 — Install-smoke + Release canary

Docker-based install verification. L0 simulates what a fresh marketplace install does (clone → `bun install` → cold-spawn the MCP server) so distribution regressions — missing `dist/`, absent postinstall build, server failing to boot — are caught before they reach a user. The Release canary builds on the same image, then also runs the L5 doctrine flows against the marketplace-installed plugin (RC-only, token-heavy).

| File | Purpose |
|---|---|
| [`install-smoke.Dockerfile`](./install-smoke.Dockerfile) | L0 image — each `RUN test` line is a fail-fast assertion that a cold install boots cleanly |
| [`run-install-smoke.sh`](./run-install-smoke.sh) | Local convenience wrapper that builds the install-smoke image from the plugin root |
| [`release-canary.Dockerfile`](./release-canary.Dockerfile) | Install-smoke + full L5 doctrine flows against the marketplace artifact in one image |
| [`run-release-canary.sh`](./run-release-canary.sh) | Local wrapper for the canary — builds image only without a token, full L0+L5 run with `CLAUDE_CODE_OAUTH_TOKEN` |
