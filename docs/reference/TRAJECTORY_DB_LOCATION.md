# Where the trajectory DB lives

One rule decides which `trajectory.db` the MCP server and every hook use. It is implemented in exactly two places — the server's `findExistingClaudeDbUp` in [`mcp/trajectory-server/src/platform.ts`](../../mcp/trajectory-server/src/platform.ts) and the hooks' `tmb_db_path` in [`scripts/hooks/lib/query-task.sh`](../../scripts/hooks/lib/query-task.sh) — and [`tests/l1-lint/no-private-db-path.sh`](../../tests/l1-lint/no-private-db-path.sh) fails on a third copy.

## Resolution order

1. **`TRAJECTORY_DB_PATH`**, if set. The file must exist; otherwise the DB is unresolved (the server creates it there).
2. **Walk up** from `CLAUDE_PROJECT_DIR` (Claude Code sets it for hooks and for the MCP server), else from the working directory, and collect every ancestor `.claude/<plugin>/trajectory.db`. A session opened in a subdirectory of a workspace therefore finds the workspace DB.
   - Never enter `$HOME` unless the walk started there.
   - No `.git` stop: a workspace root above a nested repo is reachable.
   - Skip a stale legacy DB (its `tasks` table has no `prompt_bearing` column). A candidate whose read fails is kept, so the failure surfaces instead of resolving somewhere else.
   - A candidate whose state dir holds a **`standalone`** file (`<dir>/.claude/<plugin>/standalone`) ends the walk and wins: that directory is its own project.
   - Otherwise the **outermost** candidate wins (the workspace root beats a nested repo).
3. Otherwise **unresolved**. The server then creates a fresh DB at `<CLAUDE_PROJECT_DIR or cwd>/.claude/<plugin>/trajectory.db`.

Under a test flag (`TMB_FORBID_LIVE_SYNC=1` or a set `TMB_TEST_RUN_ID`) the hooks and `scripts/scan.sh` (`tmb_db_path`) never walk: they use `CLAUDE_PROJECT_DIR`'s own DB when it exists, and without `CLAUDE_PROJECT_DIR` the DB is unresolved and one stderr line names the flag.

Nothing under `$HOME` takes part in the rule.

## The project root

The project root is the directory holding the resolved DB (`<root>` in `<root>/.claude/<plugin>/trajectory.db`), on both sides: the hooks' `tmb_project_root`, the server's spawn cwd and its tool defaults. `CLAUDE_PROJECT_DIR` stands in only when no DB resolves. A relative `repos.path` resolves against the project root.

## Who opens and migrates it

Only the trajectory-server migrates the DB. Its two entries (`src/index.ts` for Claude Code, the Codex runtime behind `src/codex.ts`) open it with `new TrajectoryDB(path, deps, { migrate: true })`. Every other opener — maintenance scripts, smoke scripts, tests — opens without `migrate`, and on a DB whose `plugin_meta.schema_version` is older than the code's it throws `TrajectoryDB: schema v<stored> is older than this code's v<target>; only the trajectory-server migrates the DB. …` before it takes a backup or runs any DDL. A fresh DB and a current-version DB open normally. SQLite has no access control, so the opener enforces this, not the MCP role checks.

Scripts that open the DB never run this rule. `scripts/maintenance/run-scan.mjs`, `run-scan-initial.mjs` and `mcp/trajectory-server/scripts/smoke-world-model.mjs` require `TRAJECTORY_DB_PATH` and exit 2 without it; the hooks that launch the scan invokers (`post-task-close-rescan.sh`, `session-start-prescan.sh`) resolve the path with `tmb_db_path` and pass it explicitly. To run one by hand against a project's data, point `TRAJECTORY_DB_PATH` at a copy.

## Other DBs

`trajectory_doctor`'s `no_other_trajectory_dbs` contract (warn) lists every other live DB: those the walk from `CLAUDE_PROJECT_DIR` passed, and those below the project root up to four levels deep (dot directories and `node_modules` are skipped; a `standalone` project and everything under it is not counted). Each entry names the path with its issue and task counts. It is a file contract, so it runs in `trajectory_doctor` only, not in the SessionStart banner.

`/onboard` Round 0 shows the same list (`onboard_state_get` → `nesting`). When the session sits below the project root, or another DB exists, it asks whether to use the workspace, make the session directory its own project (`onboard_apply(standalone=true)` writes the `standalone` marker and a fresh DB there, then the session must restart), or cancel. On the workspace answer it offers to remove each empty stray DB (`onboard_apply(remove_stray_dbs=[…])`); a DB with any issue or task is never removed.

`<plugin>` is the `name` in `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` (`tmb` when unset). The `.claude` host directory is one variable in each implementation (`TMB_STATE_HOST_DIR` in the hook lib, `CLAUDE_STATE_HOST_DIR` in `platform.ts`).

## What the hooks do with the result

| State (`tmb_db_state`) | Meaning | Deny-capable gates | Advisory hooks |
|---|---|---|---|
| `unresolved` | No DB anywhere — the project is not onboarded (or `sqlite3` is missing) | Allow. TMB never bricks a non-TMB repo. | Silent no-op |
| `ok` | The DB answers a read | Decide normally | Run normally |
| `error` | The DB resolved but the read failed — busy, corrupt, or unreadable | Deny with `BLOCKED: trajectory DB unavailable — <hook> could not read <path> …` in the gate's normal deny format | Allow, print one stderr line |

Deny-capable gates read through `tmb_gate_read`, which prints `__ERR__` on a sqlite3 failure so "no rows" and "DB unavailable" never look alike.
