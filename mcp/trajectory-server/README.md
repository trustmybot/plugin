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
| `TRAJECTORY_DB_PATH` | `.trajectory.db` in CWD | Absolute path to the SQLite database |

Set by Claude Code as `${CLAUDE_PLUGIN_DATA}/trajectory.db`. See issue #29 for pending per-project DB-path scoping.

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

Role-gating is enforced per-tool via `requireRoles()` in `middleware/agent-scope.ts`. Valid roles: `gatekeeper`, `architect`, `swe`, `pr-reviewer`, plus the back-compat alias `secretary` → `gatekeeper`.

## `branch_id` format

Every task's `branch_id` must follow the git-convention format:

```
<type>/<slug>
```

where `<type>` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `build`, `ci`, `style`, or `revert`, and `<slug>` is lowercase alphanumeric with hyphens (max 63 chars, must start with an alnum character). Examples: `feat/user-login`, `fix/auth-crash`, `refactor/extract-helper`.

`branch_id` doubles as the working git branch name for the task's worktree. `task_first_actionable` returns tasks in lexicographic order of `branch_id`, which groups them by type prefix.

## Schema versions

| Version | Highlights |
|---|---|
| 2 | Initial shipped schema (9 tables + base columns) |
| 3 | `file_registry`, `plugin_config`, `identity`, `regen_state` tables added |
| 4 | `tasks.task_spec_path`, `tasks.commit_sha`, `discussions` table added |
| 5 | `tasks.spec_body_md` added (task specs inline, not on disk) |
| 6 | `tasks.task_spec_path` dropped; `validation_attempts.task_id` upgraded to `INTEGER NOT NULL REFERENCES tasks(id)` |

Current target: **v6**.

### Migration policy

On startup, `TrajectoryDB` reads `plugin_meta.schema_version` and applies the right path:

- **`>= 3`** (i.e., 3, 4, or 5): **in-place migration** via `applyV3ToV4` → `applyV4ToV5` → `applyV5ToV6` as needed. No backup; rows preserved.
- **`2`** or lower: **hard-break backup**. The existing file (plus `-wal`/`-shm` sidecars) is renamed to `<path>.v<N>.bak.<epoch>` and a fresh `v6` database is initialized. Data is NOT migrated — the backup is the user's responsibility to inspect.
- **`> 6`**: constructor throws with a clear error. The DB was written by a newer binary; upgrade or restore from backup.
- **`:memory:` or non-existent path**: migration check skipped; fresh `v6` DB.

The in-place path covers every supported upgrade from a v0.3 release. Hard-break only fires for pre-v0.3 (v2) databases.
