# @trustmybot/trajectory-server

MCP stdio server that persists the full TMB workflow trajectory to SQLite.
Implements the 17-tool surface defined in Phase 2 of the v0.2 redesign plan.

## Build & run

```sh
npm install
npm run build
npm start
```

## Test

```sh
npm test
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `TRAJECTORY_DB_PATH` | `.trajectory.db` in CWD | Absolute path to the SQLite database |

Set by Claude Code as `${CLAUDE_PLUGIN_DATA}/trajectory.db`. Falls back to
`.trajectory.db` under the current working directory when unset.

## Tools advertised (17)

- `issue_create` — open a new issue (objective)
- `issue_get` — fetch a single issue by id
- `issue_close` — close an issue with a status
- `issue_list` — list open/in-progress issues
- `task_create` — create tasks for an issue from a blueprint array
- `task_get` — fetch a single task by issue + branch_id
- `task_update_status` — advance a task's status
- `task_list` — list all tasks for an issue
- `ledger_log` — append an event to the ledger
- `ledger_get` — retrieve ledger entries for an issue
- `audit_log` — record a tool invocation in the audit table
- `audit_get` — retrieve audit entries for an issue/task
- `skill_create` — register a new skill
- `skill_get` — fetch a skill by name
- `skill_list` — list active skills
- `skill_record_outcome` — record success/failure for effectiveness tracking
- `meta_get` — read plugin_meta (schema_version, plugin_version)

## Schema versions

| Version | Release | Changes |
|---|---|---|
| 1 | v0.2 initial | 9 tables: issues, tasks, ledger, audit, validation_attempts, skills, roundtables, roundtable_votes, plugin_meta |
| 2 | v0.2 B1/B2/B3 fixes | Added `post_commit_hash` on issues, `is_truncated` on ledger, audit `round` scoped per (issue_id, branch_id) |
| 3 | v0.3 Phase 0 | Adds file_registry, plugin_config, identity, regen_state tables |

### Hard-break migration policy

On startup, `TrajectoryDB` reads `plugin_meta.schema_version` from the existing
database file before running `schema.sql`.

- **Lower version (`< 3`)**: the existing file is renamed to
  `<path>.v<N>.bak.<epoch>` (along with `-wal` and `-shm` sidecars when
  present), a warning is logged to stderr, and a fresh schema_version=3
  database is initialized at the original path.
- **Same version (`=== 3`)**: no-op, startup continues normally.
- **Higher version (`> 3`)**: the constructor throws — the database was written
  by a newer binary; upgrade the plugin or restore from backup.
- **`:memory:` or non-existent path**: migration check is skipped entirely.

Backup files are user's responsibility to inspect or discard. No
data-preserving migration script exists in v0.3 by design: later phases
introduce destructive schema changes that would invalidate any migration
written now. Hard-break + backup preserves data without burning effort.
