From the project root: `claude plugin update tmb@trustmybot-dev --scope local`, then fully quit and relaunch Claude Code.
claude plugin marketplace add trustmybot/marketplace-dev --scope local
claude plugin disable tmb@trustmybot-rc --scope local
The plugin lives at [trustmybot/plugin](https://github.com/trustmybot/plugin).
Edit `.claude-plugin/plugin.json` or `mcp/trajectory-server/src/db.ts`.
Logs go to `<project>/.claude/tmb/logs/mcp-server.log` and `logs/mcp-health.log`.
The checkout sits under /plugin/ in the container.
Run /scan to refresh the world model, or /onboard to change policy.
The cache is ~/.claude/plugins/cache/trustmybot/tmb/1.2.0/.
