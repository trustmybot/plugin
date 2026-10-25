#!/usr/bin/env bash
# shellcheck disable=SC2034
remediate "Run /plugin and disable the extra copy, then restart Claude Code."
remediate "Once the cache updates, run /reload-plugins to load the new definitions."
CONTEXT="restart Claude Code (or reconnect the trajectory-server via /mcp) to apply"
# mid-session and running /reload-plugins, it injects the persona once
echo '/plugin enable tmb'
