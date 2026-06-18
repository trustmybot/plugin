# @trustmybot/trajectory-server

MCP stdio server that persists TMB workflow trajectory to SQLite. Bundled with the TMB plugin; registered via `plugin/.mcp.json`.

## Build & run

```sh
bun install
bun run build
node dist/index.js
```

(The plugin spawns this automatically via `.mcp.json` — manual run is only needed for isolated testing.)

## Test

```sh
node --test dist/test/*.test.js
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `TRAJECTORY_DB_PATH` | walk-up from `<cwd>` to find an existing `.claude/<plugin-name>/trajectory.db`; fall back to `<cwd>/.claude/<plugin-name>/trajectory.db` | Absolute path to the SQLite database, or `:memory:` for ephemeral runs |

Default is project-local, per-user, gitignored (the plugin-root `.gitignore` excludes `.claude/`). The `<plugin-name>` segment is read from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`'s `name` field. Both stable and RC channels currently ship `name=tmb`, so both resolve to `.claude/tmb/` — install only one channel at a time to avoid DB collision. The walk-up handles workspace-pattern projects where the live DB lives at the workspace root above multiple inner repos (#2872). Set the env var to override for CI, isolated tests, or shared testbeds.

## Tool families

Tools are registered in `src/tools/index.ts`, grouped by domain:

| Family | File | Example tools |
|---|---|---|
| Issues | `tools/issues.ts` | `issue_create`, `issue_get`, `issue_resume`, `issue_close`, `issue_snapshot_md` |
| Tasks | `tools/tasks.ts` | `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable` |
| Discussions | `tools/discussions.ts` | `discussion_append`, `discussion_list` |
| Audit | `tools/audit.ts` | `audit_log`, `audit_log_list` |
| Validation | `tools/validation.ts` | `validation_record`, `validation_history` |
| Skills (builtin rows in the unified `cheatcodes` registry, #101) | `tools/skills.ts` | `skill_register` (takes `scope`), `skill_promote` |
| Reports | `tools/reports.ts` | `issue_report_md` |
| Config | `tools/config.ts` | `config_get`, `config_set`, `config_list` |
| Onboard | `tools/onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` |
| Scan (workspace + repos) | `tools/scan.ts` | `scan_run` (forks `scripts/scan.sh` for deterministic discovery), `repos_list` |
| World model | `tools/world-model.ts` | `world_model_get`, `world_model_search`, `scan_run` → kuzu graph DB |

Role-gating is enforced per-tool via `requireRoles()` in `middleware/agent-scope.ts`. Valid first-class roles: `bro`, `swe`, `pr-reviewer`. Consultant roles (`architect`, `cto`, `ceo`, `pm`, and any user-created agent name) are accepted as open-enum values; the server grants them consultant-level access.

## `branch_id` format

Every task's `branch_id` must follow the git-convention format:

```
<type>/<slug>
```

where `<type>` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `build`, `ci`, `style`, or `revert`, and `<slug>` is lowercase alphanumeric with hyphens (max 63 chars, must start with an alnum character). Examples: `feat/user-login`, `fix/auth-crash`, `refactor/extract-helper`.

`branch_id` doubles as the working git branch name for the task's worktree. `task_first_actionable` returns tasks in lexicographic order of `branch_id`, which groups them by type prefix.

## Schema

Current baseline: `TARGET_SCHEMA_VERSION = 20` (see `src/db.ts`). `schema.sql` is applied on open via `CREATE TABLE IF NOT EXISTS` semantics. On open, the stored `schema_version` is compared against `TARGET_SCHEMA_VERSION` via `db.ts:runMigrations`; if behind, a `.bak` snapshot is written before any migration runs, then migrations execute in sequence and `schema_version` is updated on success. Rollback is via the `.bak` file. Migration correctness is covered by `src/test/schema-upgrade.test.ts`.

`plugin_meta` tracks `schema_version` + `plugin_version`. `plugin_version` is synced dynamically from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` on every `TrajectoryDB` construction — fresh and existing DBs auto-update without a migration; the schema placeholder `'0.0.0'` applies only when `CLAUDE_PLUGIN_ROOT` is unset (e.g. test runs).
