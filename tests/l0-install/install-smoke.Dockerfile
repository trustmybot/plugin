# Layer 0 — Distribution / cold-start install smoke, the Linux wrapper
#
# Simulates what a marketplace install does: build the published payload,
# strip node_modules, then cold-spawn the MCP server, `claude plugin install`
# the tree and boot it from the installed cache. The assertions live in
# install-smoke.ts (GH 1749), the same driver release-gate runs host-native on
# macOS and Windows; this image only provides the Linux host for it.
#
# Build:
#   docker build -f tests/l0-install/install-smoke.Dockerfile -t tmb-install-smoke .
#
# Build success = release shippable on Linux.

FROM node:22-slim

# Install bun + sqlite (CC's plugin install runtime assumes bun for workspace handling).
# Node 22 is the minimum because the MCP server uses node:sqlite (stdlib, behind
# --experimental-sqlite on 22.x, stable on 24+) — that's how v0.3.0 eliminated
# the entire native-binding bug class that broke v0.2.0.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip git ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# Pin bun to .bun-version, the one source every workflow reads, so the install
# layer's cache key tracks it: the canary must never validate the committed
# bun.lock with a cache-stale bun. Copied right before the install RUN so
# changing .bun-version invalidates this layer.
COPY .bun-version /tmp/.bun-version
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v$(tr -d '[:space:]' < /tmp/.bun-version)"
ENV PATH="/root/.bun/bin:${PATH}"

# The real claude CLI, for the driver's `claude plugin install` step (A0b).
RUN npm i -g @anthropic-ai/claude-code \
 && command -v claude >/dev/null \
 || (echo "❌ FAIL: claude CLI did not install" && exit 1)

# Copy the plugin tree as it would be served from the marketplace
WORKDIR /plugin
COPY . /plugin

# Build the generated payload the way CI publishes it (GH 2054), then strip
# node_modules + bun artifacts so we test cold-start. DELIBERATELY KEEP the
# built dist/ — that's what the published artifact contains, and what CC sees
# on install.
RUN bun install --frozen-lockfile --ignore-scripts \
 && (cd dashboard && bun install --frozen-lockfile) \
 && bun run build:payload
RUN rm -rf node_modules \
           mcp/trajectory-server/node_modules \
           dashboard/node_modules

# Every assertion (A0, A0b, A0d, A0e, A0c, A1–A4, A6, A3b, A3c, A7) on a temp
# copy of /plugin; --prebuilt keeps the dist/ built above.
RUN node --experimental-strip-types tests/l0-install/install-smoke.ts --prebuilt
