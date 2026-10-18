# Fixture: fail tokens beside allowlist tokens
${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/index.js is the installed server.
The state lives in .claude/tmb/ next to scripts/hooks/ notes.
The kuzu store under mcp/trajectory-server holds the world model.
The plugin cache holds mcp/trajectory-server and scripts/hooks/ copies.
CLAUDE_PLUGIN_ROOT/docs/architecture/FLOWS.md ships with the plugin.
