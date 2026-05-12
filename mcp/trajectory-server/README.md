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

Default is project-local, per-user, gitignored (the plugin-root `.gitignore` excludes `.claude/`). The `<plugin-name>` segment is read from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` so the stable channel writes to `.claude/tmb/` and the RC channel writes to `.claude/tmb-rc/` — both can be installed simultaneously without colliding (#87). The walk-up handles workspace-pattern projects where the live DB lives at the workspace root above multiple inner repos (#2872). Set the env var to override for CI, isolated tests, or shared testbeds.

## Tool families

Tools are registered in `src/tools/index.ts`, grouped by domain:

| Family | File | Example tools |
|---|---|---|
| Issues | `tools/issues.ts` | `issue_create`, `issue_get`, `issue_resume`, `issue_close`, `issue_snapshot_md` |
| Tasks | `tools/tasks.ts` | `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable` |
| Discussions | `tools/discussions.ts` | `discussion_append`, `discussion_list` |
| Audit | `tools/audit.ts` | `audit_log`, `audit_log_list` |
| Validation | `tools/validation.ts` | `validation_record`, `validation_history` |
| Skills | `tools/skills.ts` | `skill_register`, `skill_get`, `skill_record_outcome` |
| Reports | `tools/reports.ts` | `issue_report_md` |
| Config | `tools/config.ts` | `config_get`, `config_set`, `config_list` |
| Onboard | `tools/onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` |
| File registry | `tools/file-registry.ts` | `file_registry_upsert`, `file_registry_list`, `file_registry_verify`, `file_registry_delete`, `file_registry_update_summaries` |
| Scan (workspace + repos + bulk file rows) | `tools/scan.ts` | `scan_run` (forks `scripts/scan.sh` for deterministic discovery), `repos_list`, `file_registry_bulk_upsert` |

Role-gating is enforced per-tool via `requireRoles()` in `middleware/agent-scope.ts`. Valid roles: `bro`, `architect`, `swe`, `pr-reviewer`.

## `branch_id` format

Every task's `branch_id` must follow the git-convention format:

```
<type>/<slug>
```

where `<type>` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `build`, `ci`, `style`, or `revert`, and `<slug>` is lowercase alphanumeric with hyphens (max 63 chars, must start with an alnum character). Examples: `feat/user-login`, `fix/auth-crash`, `refactor/extract-helper`.

`branch_id` doubles as the working git branch name for the task's worktree. `task_first_actionable` returns tasks in lexicographic order of `branch_id`, which groups them by type prefix.

## Schema

Single baseline — `schema_version = 1`. The plugin has no users in the wild, so there is no migration machinery; `schema.sql` is applied on every open with `CREATE TABLE IF NOT EXISTS` semantics. When a future change warrants a breaking upgrade, a `v1 → v2` migration path will land in the same release that ships the new schema.

`plugin_meta` tracks `schema_version` + `plugin_version` so the migration path, when it arrives, has somewhere to look. `plugin_version` is synced dynamically from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` on every `TrajectoryDB` construction — fresh and existing DBs auto-update without a migration; the schema placeholder `'0.0.0'` applies only when `CLAUDE_PLUGIN_ROOT` is unset (e.g. test runs).
