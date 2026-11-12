# Upgrading TMB

An upgrade moves the plugin files, which Claude Code fetches when the `version` in `plugin.json` changes, and the trajectory DB, which the MCP server migrates on its first boot after a full quit and relaunch. Nothing short of a full restart applies either.

## Plugin files

- **Version.** SessionStart prints `Plugin version:`; `claude plugin list` shows each install's version and scope. A newer cached version than the running one adds a "fully quit and relaunch" line.
- **Check now.** `claude plugin marketplace update <marketplace>` (`trustmybot`, `trustmybot-rc` or `trustmybot-dev`) skips the poll.
- **Switch channels.** Uninstall the current one and install the other, each with an explicit `--scope` ([INSTALL.md](./INSTALL.md#recommended-scope-project-or-local)). The DB is per project, so data carries over.
- **Prune or reset the cache.** `node --experimental-sqlite <plugin-source>/mcp/trajectory-server/dist/cli.js heal-mcp-cache [--dry-run] [--channel stable|rc|dev]` clears a per-project MCP disable flag, prunes old cached versions, and can wipe the channel's cache for a clean reinstall. It asks before each change.

## Trajectory DB migration

The MCP server compares the DB's `schema_version` with its own. When the DB is behind, it takes the write lock, writes `<dbpath>.pre-v<TARGET>.<timestamp>.bak`, and runs every pending migration in one transaction that rolls back whole on failure. Rows are preserved.

Migrations only go forward. To roll back, restore that backup and install a plugin version that targets the older schema; work since the upgrade is lost.

## Upgrading into v1.1.0 — remove leftover user-wide hooks

Before v1.1.0, `/onboard` wrote hook commands into `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when set), stamped `"_tmb_managed": true` or running `resolve-hook.sh`. They fire in every project, so an old gate can deny what the current one allows. TMB reports them (a SessionStart `Plugin:` line, `WARN  legacy-user-hooks` in the health check, with each object's line and the projects still below 1.1.0 to upgrade first) and never edits the file.

To remove them:

1. `cp ~/.claude/settings.json ~/.claude/settings.json.bak`.
2. Under `"hooks"`, delete each reported hook object, then any group or event key left empty.
3. `jq empty ~/.claude/settings.json` to check it still parses.
4. Delete `~/.claude/tmb-hooks/`.
5. Start a new session; the `Plugin:` line is gone.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Some gates never fire; `WARN  duplicate-plugin` | Two channels enabled in one project | Disable the extra copy at its scope (the warning prints the command), then restart |
| trajectory-server dead in one project only | `disabledMcpServers` holds `plugin:tmb:trajectory-server` for the project in `~/.claude.json` | `heal-mcp-cache` step A, or set the array to `[]`, then restart |
| Every `mcp__plugin_tmb_*` tool missing after an update; `mcp-health.log` shows `"mcp_alive":false` | Claude Code bug: hooks load from the new cache but the MCP server does not | In order: `claude --plugin-dir <plugin-source>` once; uninstall, restart, reinstall; `heal-mcp-cache` step B, reinstall, restart |
| `stored schema_version N is newer than code's max M` | Plugin downgraded | Upgrade the plugin, or restore the `.pre-v<N>` backup |
| Migration failed | Full disk, or another session held the lock past 5 s | Fix the cause and restart; the DB stayed at its old version |
| `legacy_db_no_plugin_meta` in `mcp-server.log` | DB predates schema versioning; the server adopted it | Check your data if you did not expect it |
| `no such column` or `NOT NULL constraint failed` on first boot | DB shape the migration chain does not know | Restore the newest `.bak`, stay on that version, open an issue with `sqlite3 <dbpath> '.schema'` |
