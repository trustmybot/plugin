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
