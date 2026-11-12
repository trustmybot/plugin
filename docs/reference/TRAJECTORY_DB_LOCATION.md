# Where the trajectory DB lives

One rule decides which `trajectory.db` the MCP server and every hook use; each implements it once, and a lint fails on a third copy. `<plugin>` is the `name` in `plugin.json` (`tmb` when unset).

## Resolution order

1. **`TRAJECTORY_DB_PATH`**, if set and the file exists.
2. **Walk up** from `CLAUDE_PROJECT_DIR`, else the working directory, collecting every ancestor `.claude/<plugin>/trajectory.db`. It never enters `$HOME` unless it started there, does not stop at `.git`, and skips a legacy DB that predates the current task schema. A `standalone` file beside a candidate ends the walk and wins; otherwise the **outermost** candidate wins.
3. Otherwise **unresolved**; the server creates a fresh DB at `<CLAUDE_PROJECT_DIR or cwd>/.claude/<plugin>/trajectory.db`.

Under a test flag (`TMB_FORBID_LIVE_SYNC=1` or `TMB_TEST_RUN_ID`) the hooks never walk. Scripts never run this rule: they require an explicit `TRAJECTORY_DB_PATH`.

The project root is the directory holding the resolved DB. Only the trajectory-server migrates the DB; every other opener throws on an older schema version.

`trajectory_doctor`'s `no_other_trajectory_dbs` warning lists other live DBs on the walk or up to four levels below the root, and `/onboard` offers to pick the workspace, make the session directory standalone, or remove empty strays.

## What the hooks do with the result

| State | Meaning | Deny-capable gates | Advisory hooks |
|---|---|---|---|
| unresolved | No DB anywhere (not onboarded), or no SQLite backend | Allow | Silent no-op |
| ok | The DB answers a read | Decide normally | Run normally |
| error | The DB resolved but the read failed: busy, corrupt, or unreadable | Deny with `BLOCKED: trajectory DB unavailable — <hook> could not read <path> …` | Allow, print one stderr line |
