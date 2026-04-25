# Layer 0 — Distribution / cold-start install smoke
#
# Simulates what a marketplace install does: clone repo, `bun install`,
# then immediately try to spawn the MCP server. v0.1.2 shipped without
# a postinstall build step, so dist/index.js was missing and the server
# silently failed. This Dockerfile catches that class of regression.
#
# Build:
#   docker build -f tests/docker/install-smoke.Dockerfile -t tmb-install-smoke .
#
# Each `RUN test` line is a fail-fast assertion. Build success = release shippable.

FROM node:20-slim

# Install bun + sqlite (CC's plugin install runtime assumes bun for workspace handling)
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip git ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Copy the plugin tree as it would be served from the marketplace
WORKDIR /plugin
COPY . /plugin

# Strip any local build artifacts so we test cold-start, not "what was already built"
RUN rm -rf node_modules \
           mcp/trajectory-server/node_modules \
           mcp/trajectory-server/dist \
           monitors/node_modules

# Simulate CC's plugin install: bun install at the workspace root.
# postinstall (added in v0.1.3) MUST build the workspaces, otherwise the
# next assertions fail.
RUN bun install --frozen-lockfile

# ---- Hard assertions — these would have failed on v0.1.2 ----

# A1: dist/ exists and contains the entry point
RUN test -f mcp/trajectory-server/dist/index.js \
 || (echo "❌ FAIL: mcp/trajectory-server/dist/index.js missing after install — postinstall didn't run or build failed" && exit 1)

# A2: schema.sql copied alongside (the build script does both)
RUN test -f mcp/trajectory-server/dist/schema.sql \
 || (echo "❌ FAIL: dist/schema.sql missing — build didn't copy schema" && exit 1)

# A3: MCP server actually spawns and responds to tools/list
RUN echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | timeout 8 node mcp/trajectory-server/dist/index.js 2>/dev/null \
  | grep -q '"name":"identity_get"' \
 || (echo "❌ FAIL: MCP server did not respond with tools/list containing identity_get" && exit 1)

# A4: every shipped agent template parses (frontmatter + body, ≤30 lines)
RUN bash tests/lint/agent-line-budget.sh \
 || (echo "❌ FAIL: agent-line-budget lint failed in clean install" && exit 1)

# A5: onboarding skill contract still met in the as-shipped tree
RUN bash tests/lint/onboarding-skill-contract.sh \
 || (echo "❌ FAIL: onboarding-skill-contract lint failed in clean install" && exit 1)

# A6: hook scripts are executable + syntactically valid
RUN for h in scripts/hooks/*.sh; do \
      test -x "$h" || (echo "❌ FAIL: $h not executable" && exit 1); \
      bash -n "$h" || (echo "❌ FAIL: $h has syntax error" && exit 1); \
    done

# A7: .mcp.json points at a path that actually exists in the install
RUN test -f "$(node -e 'const m=require("./.mcp.json");console.log(m.mcpServers["trajectory-server"].args[0].replace("${CLAUDE_PLUGIN_ROOT}", "/plugin"))')" \
 || (echo "❌ FAIL: .mcp.json command path does not exist in installed tree" && exit 1)

# Final marker so the build log shows we made it all the way
RUN echo "✓ Layer 0 install-smoke: all assertions passed"
