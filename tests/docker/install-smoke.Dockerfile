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

FROM node:22-slim

# Install bun + sqlite (CC's plugin install runtime assumes bun for workspace handling).
# Node 22 is the minimum because the MCP server uses node:sqlite (stdlib, behind
# --experimental-sqlite on 22.x, stable on 24+) — that's how v0.3.0 eliminated
# the entire native-binding bug class that broke v0.2.0.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl unzip git ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Copy the plugin tree as it would be served from the marketplace
WORKDIR /plugin
COPY . /plugin

# Strip local node_modules + bun artifacts so we test cold-start.
# DELIBERATELY KEEP the committed dist/ — that's what the published artifact
# actually contains, and what CC sees on install.
RUN rm -rf node_modules \
           mcp/trajectory-server/node_modules

# Simulate CC's plugin install path: `bun install --ignore-scripts`.
# CC sandboxes plugin installs and DOES NOT run lifecycle scripts (postinstall,
# preinstall, etc.) — confirmed empirically through v0.2.0 (better-sqlite3
# prebuild-install skipped → native binding missing) and v0.3.0 (postinstall
# build skipped → dist/ missing). Both bugs would have been caught here if
# the test had used --ignore-scripts from day one.
RUN bun install --frozen-lockfile --ignore-scripts

# ---- Hard assertions — these would have failed on v0.1.2 ----

# A1: dist/ exists and contains the entry point
RUN test -f mcp/trajectory-server/dist/index.js \
 || (echo "❌ FAIL: mcp/trajectory-server/dist/index.js missing after install — postinstall didn't run or build failed" && exit 1)

# A2: schema.sql copied alongside (the build script does both)
RUN test -f mcp/trajectory-server/dist/schema.sql \
 || (echo "❌ FAIL: dist/schema.sql missing — build didn't copy schema" && exit 1)

# A3: MCP server spawns and responds to tools/list
RUN echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | timeout 8 node --experimental-sqlite mcp/trajectory-server/dist/index.js 2>/dev/null \
  | grep -q '"name":"identity_get"' \
 || (echo "❌ FAIL: MCP server did not respond with tools/list containing identity_get" && exit 1)

# A3b: SQLite actually opens + a real tool call round-trips.
# tools/list does NOT exercise the DB. v0.2.0 shipped broken because the
# native better-sqlite3 binding wasn't installed but tools/list still
# responded (no tool had opened a DB yet). v0.3.0 switched to node:sqlite
# (stdlib), which removes that class of bug — but we keep the assertion to
# catch *any* future cause of "MCP starts but can't actually serve calls."
RUN ( \
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'; \
    echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; \
    echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"identity_get","arguments":{"agent":"bro"}}}'; \
    sleep 1; \
  ) \
  | TRAJECTORY_DB_PATH=/tmp/smoke-test.db timeout 8 node --experimental-sqlite mcp/trajectory-server/dist/index.js > /tmp/smoke-out.log 2>&1; \
  # Two distinct asserts: identity_get-shaped result present AND no error frame for id=2.
  # identity_get's success payload carries the literal "human_name" field; absence means it crashed.
  grep -q 'human_name' /tmp/smoke-out.log \
   && ! grep '"id":2' /tmp/smoke-out.log | grep -q '"error"' \
  || (echo "❌ FAIL: identity_get call failed — DB open or first-write broken"; \
      cat /tmp/smoke-out.log; exit 1)
RUN echo "✓ A3b: SQLite open + identity_get round-tripped"

# A4: every shipped agent template parses (frontmatter + body, ≤30 lines)
RUN bash tests/lint/agent-line-budget.sh \
 || (echo "❌ FAIL: agent-line-budget lint failed in clean install" && exit 1)

# A5: hook scripts are executable + syntactically valid
RUN for h in scripts/hooks/*.sh; do \
      test -x "$h" || (echo "❌ FAIL: $h not executable" && exit 1); \
      bash -n "$h" || (echo "❌ FAIL: $h has syntax error" && exit 1); \
    done

# A6: every path-shaped arg in .mcp.json resolves in the installed tree.
# args may interleave Node flags (--experimental-sqlite) with the entry point;
# we test all args that *look* like a path (start with ${CLAUDE_PLUGIN_ROOT}).
RUN node -e ' \
  const m = require("./.mcp.json"); \
  const args = m.mcpServers["trajectory-server"].args; \
  for (const a of args) { \
    if (a.includes("${CLAUDE_PLUGIN_ROOT}")) { \
      const path = a.replace("${CLAUDE_PLUGIN_ROOT}", "/plugin"); \
      if (!require("fs").existsSync(path)) { \
        console.error("❌ FAIL: .mcp.json arg references missing path:", a, "→", path); \
        process.exit(1); \
      } \
    } \
  } \
'

# Final marker so the build log shows we made it all the way
RUN echo "✓ Layer 0 install-smoke: all assertions passed"
