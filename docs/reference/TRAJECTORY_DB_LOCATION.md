# Where the trajectory DB lives

One rule decides which `trajectory.db` the MCP server and every hook use. It is implemented in exactly two places — the server's `findExistingClaudeDbUp` in [`mcp/trajectory-server/src/platform.ts`](../../mcp/trajectory-server/src/platform.ts) and the hooks' `tmb_db_path` in [`scripts/hooks/lib/query-task.sh`](../../scripts/hooks/lib/query-task.sh) — and [`tests/l1-lint/no-private-db-path.sh`](../../tests/l1-lint/no-private-db-path.sh) fails on a third copy.

## Resolution order

1. **`TRAJECTORY_DB_PATH`**, if set. The file must exist; otherwise the DB is unresolved (the server creates it there).
2. **The project root**: `<root>/.claude/<plugin>/trajectory.db`, where `<root>` is `CLAUDE_PROJECT_DIR` (Claude Code sets it for hooks and for the MCP server). No walking: when the file is absent the DB is unresolved, and the server creates it there.
3. **Fallback, only without a project root** (e.g. a bare `node dist/index.js`, a test harness — Claude Code sets `CLAUDE_PROJECT_DIR` for every hook, subagent ones included): walk up from the working directory and collect every ancestor `.claude/<plugin>/trajectory.db`.
   - Never enter `$HOME` unless the walk started there.
   - No `.git` stop: a workspace root above a nested repo is reachable.
   - Skip a stale legacy DB (its `tasks` table has no `prompt_bearing` column). A candidate whose read fails is kept, so the failure surfaces instead of resolving somewhere else.
   - The **outermost** candidate wins (the workspace root beats a nested repo).
   - Hooks and `scripts/scan.sh` (`tmb_db_path`) never walk under a test flag (`TMB_FORBID_LIVE_SYNC=1` or a set `TMB_TEST_RUN_ID`): the DB is unresolved and one stderr line names the flag.
4. Otherwise **unresolved**.

Nothing under `$HOME` takes part in the rule.

`<plugin>` is the `name` in `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` (`tmb` when unset). The `.claude` host directory is one variable in each implementation (`TMB_STATE_HOST_DIR` in the hook lib, `CLAUDE_STATE_HOST_DIR` in `platform.ts`).

## What the hooks do with the result

| State (`tmb_db_state`) | Meaning | Deny-capable gates | Advisory hooks |
|---|---|---|---|
| `unresolved` | No DB anywhere — the project is not onboarded (or `sqlite3` is missing) | Allow. TMB never bricks a non-TMB repo. | Silent no-op |
| `ok` | The DB answers a read | Decide normally | Run normally |
| `error` | The DB resolved but the read failed — busy, corrupt, or unreadable | Deny with `BLOCKED: trajectory DB unavailable — <hook> could not read <path> …` in the gate's normal deny format | Allow, print one stderr line |

Deny-capable gates read through `tmb_gate_read`, which prints `__ERR__` on a sqlite3 failure so "no rows" and "DB unavailable" never look alike.
