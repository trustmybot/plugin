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
| `TRAJECTORY_DB_PATH` | `<cwd>/.claude/<plugin-name>/trajectory.db` | Absolute path to the SQLite database, or `:memory:` for ephemeral runs |

Default is project-local, per-user, gitignored (the plugin-root `.gitignore` excludes `.claude/`). The `<plugin-name>` segment is read from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` so the stable channel writes to `.claude/tmb/` and the RC channel writes to `.claude/tmb-rc/` — both can be installed simultaneously without colliding (#87). Set the env var to override for CI, isolated tests, or shared testbeds.

## Tool families

Tools are registered in `src/tools/index.ts`, grouped by domain:

| Family | File | Example tools |
|---|---|---|
| Issues | `tools/issues.ts` | `issue_create`, `issue_get`, `issue_resume`, `issue_close`, `issue_snapshot_md` |
| Tasks | `tools/tasks.ts` | `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable` |
| Discussions | `tools/discussions.ts` | `discussion_append`, `discussion_list` |
| Ledger | `tools/ledger.ts` | `ledger_log`, `ledger_list` |
| Audit | `tools/audit.ts` | `audit_log`, `audit_list` |
| Validation | `tools/validation.ts` | `validation_record`, `validation_history` |
| Skills | `tools/skills.ts` | `skill_register`, `skill_get`, `skill_record_outcome` |
| Reports | `tools/reports.ts` | `issue_report_md` |
| Config | `tools/config.ts` | `config_get`, `config_set`, `config_list` |
| Identity | `tools/identity.ts` | `identity_get`, `identity_set` |
| Regen state | `tools/regen-state.ts` | `regen_state_get`, `regen_state_update` |
| File registry | `tools/file-registry.ts` | `file_registry_scan_commits`, `file_registry_list` |
| Architecture regen | `tools/architecture-regen.ts` | `architecture_regen` |

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

`plugin_meta` tracks `schema_version` + `plugin_version` so the migration path, when it arrives, has somewhere to look.
