# Release canary — install-smoke + workflow doctrine in one image (was L5+L5 combined, #112).
#
# Builds on top of the L0 install-smoke approach, then ALSO installs Claude
# Code and runs the L5 deterministic-trajectory flows against the
# marketplace-installed plugin. Catches BOTH:
#   - Install-path bugs (L0's job — bun install, dist/, MCP server cold spawn)
#   - Workflow doctrine bugs (L5's job — does bro do the right thing?)
#
# Replaces manual L5 dogfood for everything except UX-only verification.
#
# Build (requires CLAUDE_CODE_OAUTH_TOKEN secret):
#   docker buildx build \
#     --secret id=cc_token,env=CLAUDE_CODE_OAUTH_TOKEN \
#     -f tests/docker/release-canary.Dockerfile \
#     -t tmb-release-canary \
#     .
#
# OR via wrapper:
#   bash tests/docker/run-release-canary.sh
#
# Build success = release shippable AND workflow doctrine intact.

# syntax=docker/dockerfile:1.4

FROM node:22-slim

# 1. Base tooling — same as L0 plus what L5 needs (jq for scorer JSON parsing,
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

# 4. Install Claude Code CLI globally (npm puts it in /usr/local/bin → world-readable).
RUN npm install -g @anthropic-ai/claude-code \
 && claude --version

# 5. Switch to the existing non-root `node` user for the L5 step.
#    Claude Code refuses `--dangerously-skip-permissions` when running as root
#    ("cannot be used with root/sudo privileges for security reasons"). The flag
#    is required in headless `-p` mode so MCP / Bash / Edit calls aren't blocked
#    waiting on a Human approval that will never come.
#
#    The `node:22-slim` base image already provides a `node` user at UID 1000
#    (convention for node images); reuse it instead of creating a new user
#    that would collide on the same UID.
RUN chown -R node:node /plugin

# 6. Run L5 flows against the source tree (the marketplace cache layout was
#    asserted in step 3; the L5 runner uses --plugin-dir /plugin).
USER node
WORKDIR /plugin
ENV TMB_DEBUG_TRAJECTORY=1
ENV HOME=/home/node

# The runner reads CLAUDE_CODE_OAUTH_TOKEN from env. BuildKit secrets are
# mounted at /run/secrets/<id>; uid=1000 makes the file readable by node.
RUN --mount=type=secret,id=cc_token,uid=1000 \
    if [ -f /run/secrets/cc_token ]; then \
      export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/secrets/cc_token)"; \
      bash tests/dogfood/run-l5.sh \
        || (echo "❌ FAIL: L5 flows failed against marketplace-installed plugin" && exit 1); \
    else \
      echo "⊘ skip: cc_token secret not provided — install-only smoke (L0 piece passed); L5 piece needs CLAUDE_CODE_OAUTH_TOKEN."; \
    fi

# Final marker
RUN echo "✓ Release canary: install + workflow doctrine all green"
