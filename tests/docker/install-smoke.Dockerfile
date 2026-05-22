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
  | grep -q '"name":"onboard_state_get"' \
 || (echo "❌ FAIL: MCP server did not respond with tools/list containing onboard_state_get" && exit 1)

# A3b: SQLite actually opens + a real tool call round-trips.
# tools/list does NOT exercise the DB. v0.2.0 shipped broken because the
# native better-sqlite3 binding wasn't installed but tools/list still
# responded (no tool had opened a DB yet). v0.3.0 switched to node:sqlite
# (stdlib), which removes that class of bug — but we keep the assertion to
# catch *any* future cause of "MCP starts but can't actually serve calls."
RUN ( \
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'; \
    echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; \
    echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"onboard_state_get","arguments":{"agent":"bro"}}}'; \
    sleep 1; \
  ) \
  | TRAJECTORY_DB_PATH=/tmp/smoke-test.db timeout 8 node --experimental-sqlite mcp/trajectory-server/dist/index.js > /tmp/smoke-out.log 2>&1; \
  # onboard_state_get's success payload carries first_run. MCP wraps the
  # tool result in content[].text so the inner JSON is escaped — match
  # `first_run` plus any non-alphabetic separator(s) before the value.
  grep -qE 'first_run[^a-zA-Z]' /tmp/smoke-out.log \
   && ! grep '"id":2' /tmp/smoke-out.log | grep -q '"error"' \
  || (echo "❌ FAIL: onboard_state_get call failed — DB open or first-write broken"; \
      cat /tmp/smoke-out.log; exit 1)
RUN echo "✓ A3b: SQLite open + onboard_state_get round-tripped"

# A3c: semantic search round-trip — discussion_search with mode='semantic'.
# Acceptable outcomes: real results array OR warning='semantic_unavailable'
# (no ONNX model in the Docker layer). Either is a valid MCP 200 response;
# what we reject is an MCP-level error (id:2 with "error" key).
RUN ( \
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'; \
    echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; \
    echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"discussion_search","arguments":{"agent":"bro","query":"storage backend interface","mode":"semantic","k":3}}}'; \
    sleep 1; \
  ) \
  | TRAJECTORY_DB_PATH=/tmp/smoke-semantic.db timeout 8 node --experimental-sqlite mcp/trajectory-server/dist/index.js > /tmp/smoke-semantic.log 2>&1; \
  grep '"id":2' /tmp/smoke-semantic.log | grep -qvE '"error"' \
   && (grep -qE '"results"' /tmp/smoke-semantic.log || grep -qE 'semantic_unavailable' /tmp/smoke-semantic.log) \
  || (echo "❌ FAIL: discussion_search(mode=semantic) returned MCP error or unexpected payload"; \
      cat /tmp/smoke-semantic.log; exit 1)
RUN echo "✓ A3c: discussion_search(mode=semantic) returns results or semantic_unavailable (no MCP error)"

# A4: every shipped agent template parses (frontmatter + body, ≤30 lines)
RUN bash tests/lint/agent-line-budget.sh \
 || (echo "❌ FAIL: agent-line-budget lint failed in clean install" && exit 1)

# A5: hook scripts are executable + syntactically valid
RUN set -e && \
    for h in scripts/hooks/*.sh; do \
      test -x "$h" || { echo "❌ FAIL: $h not executable" >&2; exit 1; }; \
      bash -n "$h" || { echo "❌ FAIL: $h has syntax error" >&2; exit 1; }; \
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

# A7: schema migration — a legacy v1-shaped DB upgrades cleanly on first boot
# under the published artifact. Catches the regression class where a user with
# an existing trajectory.db installs a new plugin version and the MCP server
# either crashes during applySchema (missing migration logic, NOT NULL on a
# dropped column, etc.) or silently loses state (e.g. the onboarded marker).
#
# Seed minimum tables for a v1-shape DB: plugin_meta at schema_version=1,
# plugin_config (translation target), identity table populated (legacy
# onboarded marker, must be translated forward to plugin_config).
RUN sqlite3 /tmp/legacy-v1.db "\
  CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL); \
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL); \
  CREATE TABLE identity (id INTEGER PRIMARY KEY); \
  INSERT INTO plugin_meta VALUES (1, 1, '0.5.0'); \
  INSERT INTO identity VALUES (1);"

RUN ( \
    echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'; \
    echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'; \
    echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"onboard_state_get","arguments":{"agent":"bro"}}}'; \
    sleep 1; \
  ) \
  | TRAJECTORY_DB_PATH=/tmp/legacy-v1.db timeout 8 node --experimental-sqlite mcp/trajectory-server/dist/index.js > /tmp/upgrade-out.log 2>&1; \
  # Schema target tracks TARGET_SCHEMA_VERSION at build time (v2 in 0.5.x, \
  # v3 in 0.7.0-rc Phase 1 FTS5, v4 in 0.7.0-rc Phase 2 embedding tables). \
  # Read the constant rather than hardcoding so the assertion auto-tracks \
  # future migrations. \
  EXPECTED_V=$(grep -oE 'TARGET_SCHEMA_VERSION = [0-9]+' mcp/trajectory-server/src/db.ts | grep -oE '[0-9]+$'); \
  ACTUAL_V=$(sqlite3 /tmp/legacy-v1.db 'SELECT schema_version FROM plugin_meta'); \
  test "$ACTUAL_V" = "$EXPECTED_V" \
    || (echo "❌ FAIL: schema_version=$ACTUAL_V after upgrade, expected $EXPECTED_V"; cat /tmp/upgrade-out.log; exit 1); \
  test "$(sqlite3 /tmp/legacy-v1.db "SELECT value_json FROM plugin_config WHERE key='onboarded'")" = "true" \
    || (echo "❌ FAIL: onboarded marker not translated from legacy identity table"; cat /tmp/upgrade-out.log; exit 1); \
  # Backup files: v1→v2 writes pre-v2.*.bak; v2→v3 writes pre-v3.*.bak; etc. \
  # Accept any pre-vN as evidence the migration backup hook ran on the path. \
  ls /tmp/legacy-v1.db.pre-v*.bak >/dev/null 2>&1 \
    || (echo "❌ FAIL: no pre-migration .bak file written"; ls /tmp/legacy-v1.db.* 2>&1; exit 1); \
  # MCP wraps the tool result in content[].text so the inner JSON is escaped \
  # (e.g. \"first_run\":false). Pattern tolerates either escaped or raw form. \
  grep -qE 'first_run[^a-zA-Z]+false' /tmp/upgrade-out.log \
    || (echo "❌ FAIL: post-upgrade onboard_state_get did not return first_run=false"; cat /tmp/upgrade-out.log; exit 1); \
  # v5 migration must add gh_iid + gl_iid columns to issues. \
  sqlite3 /tmp/legacy-v1.db "PRAGMA table_info(issues)" | grep -q 'gh_iid' \
    || (echo "❌ FAIL: gh_iid column missing after v1→v5 upgrade"; exit 1); \
  sqlite3 /tmp/legacy-v1.db "PRAGMA table_info(issues)" | grep -q 'gl_iid' \
    || (echo "❌ FAIL: gl_iid column missing after v1→v5 upgrade"; exit 1)
RUN echo "✓ A7: legacy v1 DB upgraded to current TARGET_SCHEMA_VERSION; onboarded marker preserved; backup written; gh_iid + gl_iid present"

# Final marker so the build log shows we made it all the way
RUN echo "✓ Layer 0 install-smoke: all assertions passed"
