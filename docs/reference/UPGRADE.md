# Upgrading TMB

An upgrade moves two layers:

1. **Plugin files** — skills, agent prompts, hooks and the MCP server. Claude Code delivers them through its marketplace.
2. **Trajectory DB** — `<project>/.claude/tmb/trajectory.db`. The MCP server migrates it on its first boot after the upgrade.

Both happen on their own. This page covers what to expect, what to do when something goes wrong, and how to roll back.

---

## Layer 1 — plugin files

### Check your current version

The SessionStart project inventory prints a `Plugin version:` line at the top of every session. From the project root, `claude plugin list` shows each install's version and scope.

### Version-skew banner — "restart to apply"

Claude Code can fetch a newer version into its cache while the older MCP server and hooks keep running. The SessionStart inventory then adds:

```
newer plugin version <X.Y.Z> is installed but <A.B.C> is still running — fully quit and relaunch Claude Code to apply
```

The line is read-only, never blocks the session, and disappears once the running version matches the newest cached one.

### How Claude Code delivers an update

Claude Code polls the marketplace and picks up a new version when the `version` field in `plugin.json` changes; commits without a version bump do not trigger an update. `claude plugin marketplace update <marketplace>` (`trustmybot`, `trustmybot-rc` or `trustmybot-dev`) checks now instead of waiting for the poll.

The new files are inert until Claude Code restarts. **Fully quit Claude Code (⌘Q in the desktop app) and relaunch it.** The fresh MCP server finds the DB behind its schema, migrates it (Layer 2), and the same restart loads the new hooks, skills, agents and commands. Nothing short of a full restart applies a pending migration.

### Pruning stale cached versions

Each update leaves the previous version under `~/.claude/plugins/cache/<marketplace>/tmb/<version>`. The bundled `heal-mcp-cache` helper reclaims the space. Run it from a terminal:

```bash
node --experimental-sqlite <plugin-source>/mcp/trajectory-server/dist/cli.js heal-mcp-cache --dry-run
node --experimental-sqlite <plugin-source>/mcp/trajectory-server/dist/cli.js heal-mcp-cache
```

It runs three steps in order — A (clear a per-project MCP disable flag), C (prune old versions, keeping the active one and the one before it) and B (remove the channel's whole plugin cache and TMB's install records, so a reinstall starts clean) — and asks before each change; `--dry-run` only reports. With more than one channel installed, pass `--channel stable|rc|dev`. It is safe to re-run.

### Switching channels

Uninstall the current channel, add the other channel's marketplace, and install from it, each with an explicit `--scope` (`project` or `local`). [INSTALL.md](./INSTALL.md#recommended-scope-project-or-local) has the commands for stable (`trustmybot`), rc (`trustmybot-rc`) and dev (`trustmybot-dev`). The trajectory DB is per project, so your data carries over.

---

## Layer 2 — trajectory DB migration

On its first boot after an upgrade, the MCP server compares the DB's `schema_version` (an integer, separate from the plugin version) with the one its code targets. When the DB is behind, it takes the DB's write lock, so concurrent sessions wait and then skip; writes a backup to `<dbpath>.pre-v<TARGET>.<timestamp>.bak` next to the live DB, once per target version; runs every pending migration, one version at a time, in a single transaction that rolls back whole on any failure; and records the new `schema_version`. Row data on every workflow table is preserved: the chain adds tables and columns, rebuilds tables whose columns change by copying their rows, drops tables that features no longer use, and re-types or renames legacy values in place.

### Upgrading into v1.1.0 — the bro persona loads from the plugin

Claude Code does not load a plugin's `CLAUDE.md`, so two hooks deliver bro's persona as session context ([INSTALL.md](./INSTALL.md#where-bros-persona-comes-from)). After installing or upgrading mid-session, fully quit and relaunch Claude Code. TMB never writes to `<project>/CLAUDE.md`. A `<!-- tmb:persona start … -->` … `<!-- tmb:persona end -->` block that an earlier release candidate's `/onboard` copied there is no longer needed; delete the marked lines when you like.

### Upgrading into v1.1.0 — remove leftover user-wide hooks

Before v1.1.0, `/onboard` wrote hook commands into the user-wide `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when that is set), most running `bash ~/.claude/tmb-hooks/resolve-hook.sh --marketplace <mp> --hook <name>`, some stamped `"_tmb_managed": true`. Claude Code runs them in every project, so an old gate can deny a call v1.1.0 allows. v1.1.0 writes its headless shim only into `<project>/.claude/settings.local.json`, so every hook object in the user-wide file that is stamped `"_tmb_managed": true` or runs `resolve-hook.sh` is a leftover.

TMB reports them and never edits the file. The SessionStart inventory adds one `Plugin:` line, and the health check (`node --experimental-sqlite <plugin-source>/mcp/trajectory-server/dist/cli.js health`) prints `WARN  legacy-user-hooks` without changing its exit code. Both name the file, the count, and the line of each object's `"command"` with its `--hook` name (`?` when it has none). They also list your other projects whose recorded TMB install is below 1.1.0: those lose their headless gates once you remove the user-wide copies, so upgrade them first.

To remove them:

1. Back up the file: `cp ~/.claude/settings.json ~/.claude/settings.json.bak`.
2. Under `"hooks"`, delete each hook object stamped `"_tmb_managed": true` or whose `"command"` runs `resolve-hook.sh` (the reported lines). Then delete any group whose `"hooks"` array is now empty, and any event key whose array is now empty. Leave every other entry as it is.
3. Check the file still parses: `jq empty ~/.claude/settings.json`.
4. Delete `~/.claude/tmb-hooks/` once nothing references it.
5. Start a new Claude Code session. The `Plugin:` line is gone.

---

## Failure modes

### Two enabled TMB copies — gates silently missing

Enabling a second channel without removing the first (say `tmb@trustmybot-dev` and `tmb@trustmybot-rc` in one project, at any mix of scopes) leaves two enabled plugins named `tmb`. Claude Code registers the hooks of only one and skips the other's with a plugin load error, so MCP tools can keep working while some gates never fire. TMB detects this from Claude Code's plugin records and settings files and reports it in the SessionStart banner, as `WARN  duplicate-plugin` in the health check, and as an error from `trajectory_doctor`. Fix: from the project root, disable the extra copy at its scope (the warnings print the command, e.g. `claude plugin disable tmb@trustmybot-rc --scope local`), then fully quit and relaunch Claude Code.

### MCP server disabled for one project

If the trajectory-server stopped working in one project but works in others, Claude Code may have stored a per-project `disabledMcpServers` flag in `~/.claude.json`, which survives plugin re-enables, restarts and even `rm -rf .claude/`. Check it:

```bash
jq '.projects."<absolute-project-path>".disabledMcpServers' ~/.claude.json
```

An array containing `"plugin:tmb:trajectory-server"` is the cause. `heal-mcp-cache` Step A offers to clear it; or set the array to `[]` yourself, then fully quit and relaunch Claude Code. Claude Code writes this flag when a user disables the server in its UI, and possibly when it disables a misbehaving server on its own.

### MCP server never registers after an upgrade

After a disable and re-enable, or an auto-update, Claude Code can load TMB's hooks, skills, agents and commands from the new cache directory but leave the MCP server out, and a full restart does not fix it. Symptoms: every `mcp__plugin_tmb_*` tool fails with "no matching deferred tools", `<project>/.claude/tmb/logs/mcp-health.log` shows `"mcp_alive":false`, and bro's prompts carry a HALT telling it the server is down.

Try these in order and stop at the first that brings the server back:

1. Start once with the plugin source inline, which forces Claude Code to rebuild its plugin cache: `claude --plugin-dir <plugin-source>`.
2. Uninstall the plugin at its scope, fully quit and relaunch Claude Code, then install it again from the project root ([INSTALL.md](./INSTALL.md#recommended-scope-project-or-local)).
3. Run `heal-mcp-cache` (above) and answer y to Step B, which keeps every other plugin's record, then install again and relaunch.

This is a Claude Code bug the plugin cannot patch; TMB's defenses are the HALT check and `heal-mcp-cache`.

### "stored schema_version N is newer than code's max M"

The plugin is older than the DB, most likely from an accidental downgrade. Upgrade the plugin to a version that targets N or later, or restore the backup taken before the newer migration (`cp <dbpath>.pre-v<N>.<timestamp>.bak <dbpath>`).

### Migration failed

The transaction rolls back and the DB stays at its old version, with the backup in place. Common causes are a full disk or another session holding the write lock past the 5-second busy timeout. Free space or close the other session, then restart Claude Code to re-run the migration from the start.

### Legacy DB with no `plugin_meta` table

A DB that has workflow tables but no `plugin_meta` table predates schema versioning. The MCP server adopts it: it applies the schema, records `schema_version` and keeps your rows. It warns rather than adopting silently — a `legacy_db_no_plugin_meta` line in `<project>/.claude/tmb/logs/mcp-server.log` and a `WARNING: trajectory DB had tables but no plugin_meta row …` on stderr. If you did not expect a legacy DB here, back up the file and check your data before continuing.

### Unknown legacy shape

A DB in a shape the migration chain does not know (for example, one written by a development branch with experimental tables) can fail with `no such column` or `NOT NULL constraint failed` on the first run after an upgrade. Open an issue with the output of `sqlite3 <dbpath> '.schema'`, and meanwhile restore the newest `.bak` and stay on the version that wrote it.

---

## Rolling back

Migrations only go forward. To roll back, restore the backup written just before the upgrade (`cp <dbpath>.pre-v<TARGET>.<timestamp>.bak <dbpath>`, where `<TARGET>` is the schema version you migrated to), then install a plugin version that targets the older schema. Work done since the upgrade is lost.

---

## Project-local code-reviewer override (optional)

The plugin ships one global code-reviewer, the recommended one. Claude Code resolves agents by name, so a project agent at `.claude/agents/code-reviewer.md` shadows it when a project needs custom review behavior. A project agent may declare `mcpServers: [trajectory-server]` in its frontmatter, matching a server key in your project's `.mcp.json`, which you add yourself (`/onboard` does not write it). Without MCP tools, the reviewer records its verdict through the sqlite3 fallback in the `tmb_review` skill; that verdict cannot escalate, and a FAIL does not reopen the task.

---

Releasing (version bump, rc and stable promotion) is in [RELEASE.md](../contributing/RELEASE.md).
