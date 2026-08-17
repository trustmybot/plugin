# @trustmybot/trajectory-server

MCP stdio server that persists TMB workflow trajectory to SQLite. The Claude package starts `dist/index.js` through the root `.mcp.json`; the Codex package starts the isolated `dist/codex.js` through `adapters/codex/.mcp.json`.

## Build & run

```sh
bun install
bun run build
node dist/index.js
```

(The plugin spawns this automatically via `.mcp.json` — manual run is only needed for isolated testing.)

The Codex entry exposes an immutable 15-tool adapter registry: 13 local Bro planning tools plus `agent_materialization_get` and `agent_materialization_set`. Every call requires an explicit Git worktree root with `.tmb/` already ignored and no tracked `.tmb/` files. Planning state stays beneath `<project>/.tmb/tmb/`.

The two materialization tools manage only `.codex/agents/tmb_swe.toml` and `.codex/agents/tmb_pr_reviewer.toml`. The getter is read-only and does not create `.tmb` or `.codex`. The setter installs or removes both current templates without overwriting unknown bytes. It rejects symlinks and unexpected file types, preserves all third-party Agent files, and reports a partial result if one managed target changes before a later failure. Scope 4 intentionally has no historical-template upgrades, process lock, rollback, fsync, or crash recovery.

The Codex entry does not import the Claude tool registry, write `.claude/`, create workflow tasks or validation records, or perform Git delivery operations.

See the [Codex MCP tool reference](../../docs/adapters/codex/TOOLS.md) for the
exact materialization schemas, states, results, and recovery errors.

## Test

```sh
node --test dist/test/*.test.js
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `TRAJECTORY_DB_PATH` | walk-up from `<cwd>` to find an existing `.claude/<plugin-name>/trajectory.db`; fall back to `<cwd>/.claude/<plugin-name>/trajectory.db` | Absolute path to the SQLite database, or `:memory:` for ephemeral runs. Filenames `world-model.kuzu` and `*.world-model.kuzu` are reserved for graph storage and rejected. |

Default is project-local, per-user, gitignored (the plugin-root `.gitignore` excludes `.claude/`). The `<plugin-name>` segment is read from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`'s `name` field. Both stable and RC channels currently ship `name=tmb`, so both resolve to `.claude/tmb/` — install only one channel at a time to avoid DB collision. The walk-up handles workspace-pattern projects where the live DB lives at the workspace root above multiple inner repos (#2872). Set the env var to override for CI, isolated tests, or shared testbeds.

`TrajectoryDB` has two construction modes. The existing one-argument constructor keeps Claude behavior and discovers `plugin_version` from `CLAUDE_PLUGIN_ROOT`. Supplying `TrajectoryDBDependencies` switches to an authoritative explicit mode: the provided `pluginVersion`, `serverLog`, and `sqlLog` are used without falling back to Claude process state; `pluginVersion: null` deliberately disables version synchronization. Logger callback failures are isolated and never change a database operation's result.

Codex-bound consumers pass the context's canonical `projectRoot` as `trustedProjectRoot` when creating a project logger, `TrajectoryDB`, or `WorldModelGraph`. Each consumer then revalidates its target immediately before creating or opening state. Explicit project loggers also reject symlink leaves and create new log files with mode `0600` on POSIX; the legacy Claude singleton keeps its existing append semantics. This is a fail-closed guard against path replacement between context resolution and use, not a claim of atomic protection against a same-user filesystem mutation in the final syscall window.

## Tool families

Tools are registered in `src/tools/index.ts`, grouped by domain:

| Family | File | Example tools |
|---|---|---|
| Issues | `tools/issues.ts` | `issue_create`, `issue_get`, `issue_resume`, `issue_close`, `issue_snapshot_md` |
| Tasks | `tools/tasks.ts` | `task_get`, `task_update_status`, `task_first_actionable` |
| Discussions | `tools/discussions.ts` | `discussion_append`, `discussion_list` |
| Audit | `tools/audit.ts` | `audit_append`, `audit_list` |
| Validation | `tools/validation.ts` | `validation_record`, `validation_history` |
| Skills (builtin rows in the unified `cheatcodes` registry, #101) | `tools/skills.ts` | `skill_register` (takes `scope`), `skill_promote` |
| Reports | `tools/reports.ts` | `issue_report_md` |
| Config | `tools/config.ts` | `config_get`, `config_set`, `config_list` |
| Onboard | `tools/onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` |
| Scan (workspace + repos) | `tools/scan.ts` | `scan_run` (forks `scripts/scan.sh` for deterministic discovery), `repos_list` |
| World model | `tools/world_model.ts` | `world_model_get`, `world_model_search` → kuzu graph DB |

Role-gating is enforced per-tool via `requireRoles()` in `middleware/agent-scope.ts`. Valid first-class roles: `bro`, `swe`, `pr-reviewer`. Consultant roles (`architect`, `cto`, `ceo`, `pm`, and any user-created agent name) are accepted as open-enum values; the server grants them consultant-level access.

## `branch_id` format

Every task's `branch_id` must follow the git-convention format:

```
<type>/<slug>
```

where `<type>` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `build`, `ci`, `style`, or `revert`, and `<slug>` is lowercase alphanumeric with hyphens (max 63 chars, must start with an alnum character). Examples: `feat/user-login`, `fix/auth-crash`, `refactor/extract-helper`.

`branch_id` doubles as the working git branch name for the task's worktree. `task_first_actionable` returns tasks in lexicographic order of `branch_id`, which groups them by type prefix.

## Schema

Current baseline: `TARGET_SCHEMA_VERSION = 28` (see `src/db.ts`). `schema.sql` is applied on open via `CREATE TABLE IF NOT EXISTS` semantics. On open, the stored `schema_version` is compared against `TARGET_SCHEMA_VERSION` via `db.ts:runMigrations`; if behind, a `.bak` snapshot is written before any migration runs, then migrations execute in sequence and `schema_version` is updated on success. Rollback is via the `.bak` file. Migration correctness is covered by `src/test/schema-upgrade.test.ts`.

`plugin_meta` tracks `schema_version` + `plugin_version`. In the default Claude constructor mode, `plugin_version` is synced dynamically from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` on every construction, so fresh and existing DBs auto-update without a migration. Explicit dependency mode instead treats its supplied version as authoritative; `null` performs no synchronization. The schema placeholder `'0.0.0'` applies when no version is supplied.
