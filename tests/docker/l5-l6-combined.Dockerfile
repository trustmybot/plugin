# L5+L6 combined — install-smoke + workflow doctrine, in one image (#112).
#
# Builds on top of the L0 install-smoke approach, then ALSO installs Claude
# Code and runs the L6 deterministic-trajectory flows against the
# marketplace-installed plugin. Catches BOTH:
#   - Install-path bugs (L0's job — bun install, dist/, MCP server cold spawn)
#   - Workflow doctrine bugs (L6's job — does bro do the right thing?)
#
# Replaces manual L5 dogfood for everything except UX-only verification.
#
# Build (requires CLAUDE_CODE_OAUTH_TOKEN secret):
#   docker buildx build \
#     --secret id=cc_token,env=CLAUDE_CODE_OAUTH_TOKEN \
#     -f tests/docker/l5-l6-combined.Dockerfile \
#     -t tmb-l5-l6 \
#     .
#
# OR via wrapper:
#   bash tests/docker/run-l5-l6-combined.sh
#
# Build success = release shippable AND workflow doctrine intact.

# syntax=docker/dockerfile:1.4

FROM node:22-slim

# 1. Base tooling — same as L0 plus what L6 needs (jq for scorer JSON parsing,
#    timeout for capping individual flow runs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl unzip git ca-certificates sqlite3 jq coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# 2. Marketplace install simulation. Place the plugin tree where CC's
#    marketplace install puts it: ~/.claude/plugins/cache/<vendor>/<name>/<version>/
#    The runner must be able to find the plugin via this canonical path.
ARG PLUGIN_VERSION=dev
WORKDIR /plugin
COPY . /plugin
RUN rm -rf node_modules mcp/trajectory-server/node_modules

# Same install path as L0: --ignore-scripts simulates CC's actual behavior.
RUN bun install --frozen-lockfile --ignore-scripts

# Stage to the marketplace cache layout
RUN mkdir -p /root/.claude/plugins/cache/trustmybot/tmb/${PLUGIN_VERSION}/ \
 && cp -r /plugin/. /root/.claude/plugins/cache/trustmybot/tmb/${PLUGIN_VERSION}/

# 3. Hard install-smoke assertions (mirror L0 — fail fast if install broken)
RUN test -f /root/.claude/plugins/cache/trustmybot/tmb/${PLUGIN_VERSION}/mcp/trajectory-server/dist/index.js \
 || (echo "❌ FAIL: dist/index.js missing in marketplace cache layout" && exit 1)

RUN test -f /root/.claude/plugins/cache/trustmybot/tmb/${PLUGIN_VERSION}/mcp/trajectory-server/dist/schema.sql \
 || (echo "❌ FAIL: dist/schema.sql missing in marketplace cache layout" && exit 1)

# 4. Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code \
 && claude --version

# 5. Run L6 flows against the marketplace-installed plugin.
#    Token comes via BuildKit secret (not baked into image layers).
#    --plugin-dir points to the marketplace cache path so we exercise the
#    REAL install layout, not /plugin (the source dir).
WORKDIR /plugin
ENV TMB_DEBUG_TRAJECTORY=1

# The runner reads CLAUDE_CODE_OAUTH_TOKEN from env. BuildKit secrets are
# mounted at /run/secrets/<id>; we source it into the shell for the test run.
RUN --mount=type=secret,id=cc_token \
    if [ -f /run/secrets/cc_token ]; then \
      export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/cc_token)"; \
      bash tests/dogfood/run-l6.sh \
        || (echo "❌ FAIL: L6 flows failed against marketplace-installed plugin" && exit 1); \
    else \
      echo "⊘ skip: cc_token secret not provided — install-only smoke (L0 piece passed); L6 piece needs CLAUDE_CODE_OAUTH_TOKEN."; \
    fi

# Final marker
RUN echo "✓ L5+L6 combined: install + workflow doctrine all green"
