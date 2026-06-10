# Upgrading TMB

Two layers move when you upgrade:

1. **Plugin files** — the SKILL.md, agent prompts, hooks, MCP server source. Claude Code handles this via its marketplace mechanism.
2. **Trajectory DB** — your `<project>/.claude/tmb/trajectory.db`. The MCP server migrates this on first boot after the upgrade.

Both happen automatically. This doc covers what to expect, what to do if something goes sideways, and how to roll back.

---

## Layer 1 — plugin files

### Check your current version

```bash
sqlite3 <project>/.claude/tmb/trajectory.db \
  "SELECT plugin_version FROM plugin_meta;"
```

Or open Claude Code and inspect the plugin via `/plugin info tmb`.

### How CC delivers an update

Claude Code checks the marketplace for new versions automatically. A new version is detected when the `version` field in `plugin.json` changes — pushing commits without bumping `version` does **not** trigger an update.

When CC pulls a new version, the new files land on disk but the **running MCP server keeps using the old code's path** until you reload. The schema migration is part of the MCP server's boot sequence, so the migration does not apply until the MCP server restarts.

### Trigger the new MCP server (required to apply the migration)

After CC reports the plugin updated, **run `/reload-plugins`** in your session. This restarts the MCP server (and hooks + LSP); the fresh boot detects `plugin_meta.schema_version < TARGET`, backs the DB up, applies any pending migrations, and bumps the version.

If you'd rather restart the whole session, that works too: `Cmd+R` in the desktop app, or close + reopen.

`/plugin marketplace update trustmybot` forces CC to re-check the marketplace immediately rather than waiting for its periodic poll.

### Switching channels (stable ↔ RC)

```
/plugin uninstall tmb
/plugin marketplace add trustmybot/marketplace-rc   # or trustmybot/marketplace for stable
/plugin install tmb@trustmybot-rc                    # or tmb@trustmybot
```

The trajectory DB is per-project and unaffected by the channel switch — your data carries over.

---

## Layer 2 — trajectory DB migration

### What happens on first boot after upgrade

When the MCP server starts and finds `plugin_meta.schema_version < TARGET_SCHEMA_VERSION`:

1. **Backup.** A copy is written to `<dbpath>.pre-v<TARGET>.<timestamp>.bak` next to the live DB. One backup per target version — re-opening the same DB after migration does not create additional backups.
2. **Migrate.** Migration steps run inside a single SQLite transaction. If any step fails, the transaction rolls back and your DB is left at the pre-migration version. The backup is still there.
3. **Bump.** `plugin_meta.schema_version` updates to the new target. Subsequent boots see the new version and skip migrations.

### What's in the v1 → v2 migration

- Drops zombie tables left over from earlier refactors (`identity`, `regen_state`, `project_metadata`).
- Adds `skills.scope` (default `'global'`).
- Rebuilds `tasks`, `roundtables`, `roundtable_votes` if any pre-v2 columns are still present. The new schema drops a handful of columns that were either never written or constant-by-construction; the rebuild copies surviving rows into a fresh table. The pre-v7 file-level registry is dropped at v7 as part of the world-model migration.
- Adds `agent_runs.started_at` and relaxes `completed_at` to nullable.

Row data on every workflow table is preserved.

### Verifying the upgrade

```bash
sqlite3 <project>/.claude/tmb/trajectory.db \
  "SELECT schema_version, plugin_version FROM plugin_meta;"
```

Both columns should match the version you just installed.

---

## Failure modes

### MCP server disabled via CC's per-project state (rare, hard to detect)

If your trajectory-server stopped working in ONE project but works fine in others, CC may have stored a per-project `disabledMcpServers` flag in `~/.claude.json`. This survives plugin re-enables, full CC restarts, and even `rm -rf .claude/`.

Diagnose:

```bash
jq '.projects."<absolute-project-path>".disabledMcpServers' ~/.claude.json
```

If this returns a JSON array containing `"plugin:tmb:trajectory-server"`, that's the issue.

Recovery (one of):

- **`heal-mcp-cache.sh`** clears this automatically — Step A diagnoses + offers to remove the flag. No reinstall needed.
- **Manual**:
  ```bash
  jq '.projects."<project-path>".disabledMcpServers = []' ~/.claude.json > ~/.claude.json.tmp && mv ~/.claude.json.tmp ~/.claude.json
  ```
  Then relaunch CC (or `/reload-plugins`).

The flag is written by CC when a user disables an MCP server through the CC UI, OR potentially when CC auto-disables a misbehaving server. The plugin cannot read or write it — it's CC-owned state. Track at #2888 for context on how this was discovered.

### MCP server never registers after upgrade (CC plugin cache bug, issue #2888)

After a `/plugin disable` → re-enable cycle, or after CC's auto-update lands a new tmb version, the trajectory MCP server can fail to register entirely. CC loads tmb's hooks / skills / agents / commands from the new cache dir, but the MCP server is absent from CC's resolved plugin list — and **`/reload-plugins` does not fix it. A full CC quit + relaunch does not fix it either.** CC persists the broken resolved-plugin list to disk somewhere that survives process restart.

**Symptoms:**

- `mcp__plugin_tmb_*` tools all fail with "no matching deferred tools".
- `~/.claude/tmb/logs/mcp-health.log` tail shows `"event":"SessionStart","mcp_alive":false,"mode":"A"`.
- The CC log shows hooks/skills/agents/commands loading from `~/.claude/plugins/cache/trustmybot-rc/tmb/<version>/` but no `plugin:tmb:trajectory-server` registration line.

**Recovery escalation — try IN ORDER, stop at the first that brings MCP back:**

1. **Inline source via `--plugin-dir`** — forces CC to invalidate its plugin cache:
   ```bash
   claude --plugin-dir /path/to/plugin/source
   ```
   The CC log will show `clearPluginCache: invalidating loadAllPlugins cache (preAction: --plugin-dir inline plugins)` followed by the MCP server registration.

2. **Uninstall + reinstall through `/plugin`:**
   ```
   /plugin uninstall tmb@trustmybot-rc
   ```
   Quit CC fully (⌘Q), relaunch, then `/plugin install tmb@trustmybot-rc`.

3. **Manual cache nuke + reinstall.** Use the bundled helper, which previews what it will remove, prompts for confirmation, and preserves every other plugin's entry in `installed_plugins.json`:
   ```bash
   bash <plugin-source>/scripts/maintenance/heal-mcp-cache.sh
   ```
   Then relaunch CC and `/plugin install tmb@trustmybot-rc`.

This is an upstream CC bug — the plugin cannot patch it from inside. The defenses we ship: loud Mode A detection in `mcp-health-check.sh` (the `additionalContext` warning tells bro to halt rather than silently degrade) and the `heal-mcp-cache.sh` helper above. Track at issue #2888.

### "stored schema_version N is newer than code's max M"

You're running a plugin that's older than the DB. Two ways out:

- **Re-upgrade the plugin** to a version ≥ N. This is the expected path — you probably downgraded by accident.
- **Restore the backup** from before the newer-plugin migration:
  ```bash
  cp <dbpath>.pre-v<N>.<timestamp>.bak <dbpath>
  ```

### Migration crashed mid-step

The transaction wrapping `migrateV1toV2` rolls back. Your DB stays at the old version. Common causes: filesystem full, locked DB (another CC session is running against it).

- Free disk space / close the other session, then restart CC. Migration re-runs from scratch.
- The pre-migration backup is still there if you'd rather roll back: restore the `.bak` file.

### Unknown legacy shape

If your DB has a shape neither v1 nor v2 covers (e.g. you ran the plugin from a development branch with experimental tables), the migration may not know how to upgrade it. Symptoms: `ALTER TABLE ... no such column` or `NOT NULL constraint failed` on first run after upgrade.

- Open an issue with the output of `sqlite3 <dbpath> '.schema'` attached.
- Workaround: restore the most recent `.bak` and pin to the version that wrote it.

---

## Rolling back

Migrations are forward-only. There is no v2 → v1 migration. To roll back:

1. Restore the `.bak` written at the time of the v1 → v2 migration:
   ```bash
   cp <dbpath>.pre-v2.<timestamp>.bak <dbpath>
   ```
2. Downgrade the plugin to a version that ships `schema_version=1` code.

Any work done since the upgrade is lost — the rollback restores the DB to the pre-upgrade snapshot.

---

## Enabling project-local pr-reviewer (recommended)

The plugin-global `agents/pr-reviewer.md` cannot declare `mcpServers` in its frontmatter — plugin-subagent agents don't support that field. Without MCP tools, pr-reviewer falls back to the honor-system sqlite3 path (§B path 2 in `tmb_review`). The project-local override adds `mcpServers: [trajectory-server]`, giving pr-reviewer reliable MCP access and path-1 verdicts.

### Copy the template (one-time setup per project)

```bash
mkdir -p <workspace>/.claude/agents
cp <plugin-source>/templates/project-seed/.claude/agents/pr-reviewer.md \
   <workspace>/.claude/agents/pr-reviewer.md
```

Where `<workspace>` is the directory from which you launch Claude Code (the directory containing `.claude/tmb/trajectory.db`).

### Why this works

Claude Code resolves agents by name; a project-local agent at `.claude/agents/pr-reviewer.md` shadows the plugin-global one. The project-local version declares `mcpServers: [trajectory-server]`, which CC wires up when spawning the subagent. The `trajectory-server` entry must match a key in your project's `.mcp.json` (the TMB plugin adds this during onboard).

### Verifying MCP is wired up

When pr-reviewer writes its verdict, the first line of `feedback` will be `MCP available: yes` (path 1) instead of `MCP available: no — honor-system fallback` (path 2). Query the DB to confirm:

```bash
sqlite3 <workspace>/.claude/tmb/trajectory.db \
  "SELECT feedback FROM validation_attempts ORDER BY id DESC LIMIT 1;"
```

---

## Maintainer side

### Promoting rc → stable

```bash
git checkout main
git merge --ff-only origin/rc            # or the validated commit
bash scripts/maintenance/bump-version.sh <X.Y.Z>
git commit -am "🔖 release: v<X.Y.Z>"
git tag v<X.Y.Z>
git push origin main --tags
```

### Bumping the version

`bump-version.sh` keeps the four version locations in sync atomically:

- `.claude-plugin/plugin.json`
- `package.json`
- `mcp/trajectory-server/package.json`
- The `serverLog('startup', version: '...')` literal in `mcp/trajectory-server/src/index.ts`

It does **not** touch the MCP `Server({ name, version })` constructor in `index.ts` — that's the protocol-handshake version, independent of the plugin version.

### Bumping the schema

When a schema change is breaking (drops a `NOT NULL` column, removes a table, etc.):

1. Bump `TARGET_SCHEMA_VERSION` in `mcp/trajectory-server/src/db.ts`.
2. Update the `plugin_meta` seed in `mcp/trajectory-server/src/schema.sql` to match.
3. Add a `migrateVnToVn+1(db)` function with the SQLite recipe (`CREATE TABLE _new`; copy; `DROP`; `RENAME`).
4. Add an L2 case to `mcp/trajectory-server/src/test/schema-upgrade.test.ts` with a fixture at the previous version + assertions on the upgraded shape.
5. Update `CHANGELOG.md` with the migration details + the dropped column / table.

### Testing the migration end-to-end through Claude Code

The L0 install-smoke (`tests/l0-install/install-smoke.Dockerfile`) seeds a synthetic v1-shape DB inside the docker image and asserts the migration applies cleanly. That's the automated gate. To exercise the **real CC user upgrade path** by hand — install old plugin, accumulate state, upgrade, watch the migration run — use one of these three recipes:

**Recipe A — git worktree + `--plugin-dir` (most deterministic, recommended for development).** Spin up an old plugin version as a worktree, then re-launch CC against the new source. Both sides resolve to the same trajectory DB in the test project, so the second launch triggers the migration.

```bash
# 1. Materialize an old plugin version
git worktree add /tmp/tmb-old v<PREV.VERSION>
( cd /tmp/tmb-old && bun install --frozen-lockfile && bun run build )

# 2. Fresh test project
TEST_PROJ=$(mktemp -d -t tmb-upgrade-XXXX)
( cd "$TEST_PROJ" && git init -q && git config user.email t@t.t && git config user.name t \
    && echo init > README.md && git add . && git commit -qm init )

# 3. Run CC with the OLD plugin to populate v1-shape state
cd "$TEST_PROJ"
echo '@bro hi' | claude --plugin-dir /tmp/tmb-old -p --dangerously-skip-permissions

# Confirm pre-upgrade state — schema_version should be 1
sqlite3 .claude/tmb/trajectory.db 'SELECT schema_version, plugin_version FROM plugin_meta;'

# 4. Run CC again with the NEW plugin — migration fires on MCP server boot
echo '@bro check status' | claude --plugin-dir <your-plugin-checkout> -p --dangerously-skip-permissions

# 5. Verify the migration applied
sqlite3 .claude/tmb/trajectory.db 'SELECT schema_version, plugin_version FROM plugin_meta;'
ls -la .claude/tmb/trajectory.db.pre-v2.*.bak           # one backup per target version
sqlite3 .claude/tmb/trajectory.db "SELECT value_json FROM plugin_config WHERE key='onboarded';"

# 6. Cleanup
git worktree remove /tmp/tmb-old
rm -rf "$TEST_PROJ"
```

**Recipe B — through the real marketplace (smoke-tests CC's update mechanism too).** Slower; depends on what versions are actually published.

```bash
# Inside CC:
/plugin marketplace add trustmybot/marketplace-rc
/plugin install tmb@trustmybot-rc                # whatever the marketplace currently ships
```

Use the plugin in a real project — accumulate issues, tasks, run `/onboard`. Then point the marketplace at the in-development source by switching channels or by updating the marketplace ref:

```bash
/plugin marketplace update trustmybot
# Restart the CC session (Cmd+R) so the MCP server reboots with new code.
```

The MCP server log (`~/.claude/tmb/logs/mcp-server.log`) shows the migration steps. Confirm with the same `sqlite3` queries from Recipe A.

**Recipe C — hand-craft a v1 DB (fastest, no install dance).** Useful when iterating on the migration code itself.

```bash
TEST_PROJ=$(mktemp -d -t tmb-upgrade-XXXX)
mkdir -p "$TEST_PROJ/.claude/tmb"
DB="$TEST_PROJ/.claude/tmb/trajectory.db"

# Seed a minimal v1-shape DB matching a pre-migration install
sqlite3 "$DB" "
  CREATE TABLE plugin_meta (id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, plugin_version TEXT NOT NULL);
  CREATE TABLE plugin_config (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  CREATE TABLE identity (id INTEGER PRIMARY KEY);
  INSERT INTO plugin_meta VALUES (1, 1, '<prev-version>');
  INSERT INTO identity VALUES (1);
"

# Trigger the migration by booting the MCP server against this DB
cd "$TEST_PROJ" && git init -q && git config user.email t@t.t && git config user.name t \
  && echo init > README.md && git add . && git commit -qm init
echo '@bro hi' | claude --plugin-dir <your-plugin-checkout> -p --dangerously-skip-permissions

# Verify
sqlite3 "$DB" 'SELECT schema_version FROM plugin_meta;'        # expect 2
ls "$DB".pre-v2.*.bak                                          # expect backup present
sqlite3 "$DB" "SELECT value_json FROM plugin_config WHERE key='onboarded';"   # expect "true"
rm -rf "$TEST_PROJ"
```

**Recovery — if the migration goes wrong on a real project:**

```bash
# Stop CC. Restore the .bak. Downgrade plugin. Re-launch.
cp <project>/.claude/tmb/trajectory.db.pre-v2.<timestamp>.bak <project>/.claude/tmb/trajectory.db
```
