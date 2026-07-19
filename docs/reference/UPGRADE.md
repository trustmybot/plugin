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

The SessionStart project inventory also prints a `Plugin version:` line at the top of every session, so you can see the running version without a query.

### Version-skew banner — "restart to apply"

CC can fetch a newer version into its marketplace cache while the **older** MCP server / hooks keep running until you reload. When that happens, the SessionStart inventory appends a line:

```
newer plugin version <X.Y.Z> is installed but <A.B.C> is still running — restart Claude Code (or reconnect the trajectory-server via /mcp) to apply
```

That is your cue to reload — the new files are on disk but inert until the MCP server reboots (see below). The line disappears once the running version matches the highest cached version. It is read-only and never blocks the session.

### How CC delivers an update

Claude Code checks the marketplace for new versions automatically. A new version is detected when the `version` field in `plugin.json` changes — pushing commits without bumping `version` does **not** trigger an update.

When CC pulls a new version, the new files land on disk but the **running MCP server keeps using the old code's path** until you reload. The schema migration is part of the MCP server's boot sequence, so the migration does not apply until the MCP server restarts.

### Trigger the new MCP server (required to apply the migration)

After CC reports the plugin updated, **fully quit Claude Code and relaunch it** — `Cmd+R` in the desktop app, or close + reopen. A full quit + relaunch reboots the MCP server process, and its fresh boot detects `plugin_meta.schema_version < TARGET`, backs the DB up, applies any pending migrations, and bumps the version. Reconnecting the trajectory-server via `/mcp` also reboots the server and applies the migration.

`/reload-plugins` re-reads hooks, skills, and commands from the new cache, but it does **not** restart the MCP server process — on its own it will not apply a pending migration.

If the SessionStart "newer plugin version … restart to apply" banner is showing, this is the step that clears it.

`/plugin marketplace update trustmybot` forces CC to re-check the marketplace immediately rather than waiting for its periodic poll.

### Pruning stale cached versions

Each update leaves the previous version's files in `~/.claude/plugins/cache/<owner>/tmb/<version>`. To reclaim that space, run the bundled GC — it keeps the active version plus the single previous one and removes the rest, never touching the active version:

```bash
bash <plugin-source>/scripts/maintenance/heal-mcp-cache.sh --dry-run   # preview Step C
bash <plugin-source>/scripts/maintenance/heal-mcp-cache.sh             # prompts before pruning
```

Step C is safe to re-run: once only active + previous remain it reports nothing to prune.

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
2. **Migrate.** Each version-step runs inside its own SQLite transaction. If a step fails, that step's transaction rolls back and your DB is left at the last version that committed cleanly. The backup is still there.
3. **Bump.** `plugin_meta.schema_version` updates to the new target. Subsequent boots see the new version and skip migrations.

### What the migration chain does

Migrations are chained one version at a time — `migrateV1toV2`, `migrateV2toV3`, … up to the current target — so a DB at any older version replays every step in order to reach the target. Across the chain the steps:

- Drop zombie tables left over from earlier refactors (`identity`, `regen_state`, `project_metadata`).
- Drop the pre-v7 file-level registry as part of the world-model migration.
- Drop the `skill_invocations` table; skill/cheatcode usage is tracked in the stream-json session log instead of the trajectory DB.
- Rebuild `tasks`, `roundtables`, `roundtable_votes` whenever a breaking column change lands — the rebuild copies surviving rows into a fresh table.
- Add columns as features land (e.g. `agent_runs.started_at` with nullable `completed_at`, `issues.milestone`).

Row data on every workflow table is preserved.

### Verifying the upgrade

```bash
sqlite3 <project>/.claude/tmb/trajectory.db \
  "SELECT schema_version, plugin_version FROM plugin_meta;"
```

Both columns should match the version you just installed.

### Upgrading into v1.0.0 (first stable)

v1.0.0 is the first stable release. Upgrading from any v0.10.x rc is a normal channel update — nothing special to do. The schema migrations apply on server start exactly as described above.

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

The transaction wrapping the migration step rolls back. Your DB stays at the old version. Common causes: filesystem full, locked DB (another CC session is running against it).

- Free disk space / close the other session, then restart CC. Migration re-runs from scratch.
- The pre-migration backup is still there if you'd rather roll back: restore the `.bak` file.

### Legacy DB with no `plugin_meta` row

A DB that has workflow tables but **no `plugin_meta` table** predates schema versioning. The MCP server adopts it forward — it reapplies the schema, stamps `schema_version`, and preserves your existing rows — but it does **not** treat it as a clean fresh install. So the upgrade isn't silent, boot emits a warning rather than quietly adopting it:

- `~/.claude/tmb/logs/mcp-server.log` shows a `"kind":"legacy_db_no_plugin_meta","level":"warn"` line, and the startup line carries `"legacy_db_no_plugin_meta":true`.
- stderr prints `WARNING: trajectory DB had tables but no plugin_meta row …`.

This is non-fatal. If you didn't expect a legacy DB here, back up the file and verify your data before continuing.

### Unknown legacy shape

If your DB has a shape neither v1 nor v2 covers (e.g. you ran the plugin from a development branch with experimental tables), the migration may not know how to upgrade it. Symptoms: `ALTER TABLE ... no such column` or `NOT NULL constraint failed` on first run after upgrade.

- Open an issue with the output of `sqlite3 <dbpath> '.schema'` attached.
- Workaround: restore the most recent `.bak` and pin to the version that wrote it.

---

## Rolling back

Migrations are forward-only — there is no downward migration. To roll back:

1. Restore the `.bak` written just before the upgrade migration ran (`<TARGET>` is the schema version you migrated to):
   ```bash
   cp <dbpath>.pre-v<TARGET>.<timestamp>.bak <dbpath>
   ```
2. Downgrade the plugin to a version whose code targets the older `schema_version`.

Any work done since the upgrade is lost — the rollback restores the DB to the pre-upgrade snapshot.

---

## Project-local pr-reviewer override (optional)

The plugin ships one global pr-reviewer; it is the recommended reviewer. Claude Code resolves agents by name, so a project-local agent at `.claude/agents/pr-reviewer.md` shadows the plugin-global one when a project needs custom review behavior. A project-local agent may declare `mcpServers: [trajectory-server]` in its frontmatter (plugin-global agents cannot) — the entry must match a key in your project's `.mcp.json` (added during onboard). Without MCP tools the reviewer falls back to the honor-system sqlite3 path (the fallback script in `tmb_review`); both paths produce valid verdicts.

### Verifying MCP is wired up

When pr-reviewer writes its verdict, the typed `mcp_available` column is `1` (path 1, MCP-backed) instead of `0` (path 2, honor-system). Query the DB to confirm:

```bash
sqlite3 <workspace>/.claude/tmb/trajectory.db \
  "SELECT mcp_available, verdict FROM validation_attempts ORDER BY id DESC LIMIT 1;"
```

---

## Maintainer side

### Promoting rc → stable

Promotion runs through a PR — merge `dev` → `main` via `gh pr create` + `gh pr merge` (the merge lands the version bump in `plugin.json` and its matching `CHANGELOG.md` entry) — then cut the release from `main`:

```bash
git checkout main && git pull origin main
bash scripts/release.sh
```

`release.sh` tags `main` HEAD as `v<X.Y.Z>` (read from `plugin.json`), then resolves the promoted rc's release-gate verdict via `resolve_gate_tag()`: the gate fires only on rc tags, so a stable tag resolves to the newest `v*-rc.*` tag in HEAD's ancestry — the rc it promotes — and consumes that run's verdict. It refuses to publish on a red or missing verdict, and on green creates the GitHub release from the CHANGELOG notes.

### Bumping the version

`bump-version.sh` keeps the three version manifests, plus the `bun.lock` workspace entry, in sync atomically:

- `.claude-plugin/plugin.json`
- `package.json`
- `mcp/trajectory-server/package.json`
- `bun.lock` (workspace `version`)

`mcp/trajectory-server/src/index.ts` derives the version at runtime by reading its own `package.json`, so the startup-log line and the MCP `Server({ name, version })` handshake both pick up the new version automatically — there is no hardcoded version literal to edit.

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
ls -la .claude/tmb/trajectory.db.pre-v*.bak             # one backup per target version
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

# Verify — schema_version should now match the plugin's current TARGET_SCHEMA_VERSION
sqlite3 "$DB" 'SELECT schema_version FROM plugin_meta;'
ls "$DB".pre-v*.bak                                            # expect backup present
sqlite3 "$DB" "SELECT value_json FROM plugin_config WHERE key='onboarded';"   # expect "true"
rm -rf "$TEST_PROJ"
```

**Recovery — if the migration goes wrong on a real project:**

```bash
# Stop CC. Restore the .bak. Downgrade plugin. Re-launch.
cp <project>/.claude/tmb/trajectory.db.pre-v<TARGET>.<timestamp>.bak <project>/.claude/tmb/trajectory.db
```
