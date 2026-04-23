# Trajectory DB — Entity Relationship Diagram

SQLite schema v5 (`mcp/trajectory-server/src/schema.sql`). Persistent at `${CLAUDE_PLUGIN_DATA}/trajectory.db`, owned by the bundled MCP server.

## Overview

14 tables in two groups:

| Group | Tables | Keyed by |
|---|---|---|
| **Workflow** (per-issue) | `issues`, `tasks`, `ledger`, `audit`, `validation_attempts`, `discussions`, `roundtables`, `roundtable_votes` | `issue_id` (directly or transitively) |
| **Registries** (standalone) | `skills`, `file_registry`, `plugin_config`, `identity`, `regen_state`, `plugin_meta` | own primary keys; not tied to any issue |

## Diagram

```mermaid
erDiagram
    issues ||--o{ issues : "parent_issue_id"
    issues ||--o{ tasks : "issue_id"
    issues ||--o{ ledger : "issue_id"
    issues ||--o{ audit : "issue_id"
    issues ||--o{ discussions : "issue_id"
    issues ||--o{ roundtables : "issue_id"
    issues }o--o| tasks : "current_task_id"

    tasks ||--o{ validation_attempts : "task_id (TEXT, no FK)"
    tasks ||--o{ ledger : "branch_id (soft ref)"
    tasks ||--o{ audit : "branch_id (soft ref)"

    roundtables ||--o{ roundtable_votes : "roundtable_id"

    file_registry {
        TEXT  path PK
        TEXT  type
        TEXT  language
        TEXT  last_commit_sha
        TEXT  last_change_type
    }

    skills {
        INT  id PK
        TEXT name UK
        TEXT trust_tier
        TEXT status
        INT  uses
        REAL effectiveness
    }

    plugin_config {
        TEXT key PK
        TEXT value_json
    }

    identity {
        INT  id PK "always 1"
        TEXT gatekeeper_name
        TEXT human_name
    }

    regen_state {
        TEXT target PK
        TEXT last_regen_at
        TEXT last_seen_sha
    }

    plugin_meta {
        INT  id PK
        INT  schema_version
        TEXT plugin_version
    }

    issues {
        INT  id PK
        INT  parent_issue_id FK
        TEXT objective
        TEXT goals_md
        TEXT status
        INT  current_task_id FK
        TEXT pre_commit_hash
        TEXT post_commit_hash
    }

    tasks {
        INT  id PK
        INT  issue_id FK
        TEXT branch_id
        TEXT parent_branch_id
        TEXT status
        TEXT spec_body_md
        TEXT task_spec_path "STALE"
        INT  attempts
        TEXT commit_sha
    }

    validation_attempts {
        INT  id PK
        TEXT task_id "no FK"
        INT  attempt_n
        TEXT agent
        TEXT verdict
    }

    ledger {
        INT  id PK
        INT  issue_id FK
        TEXT branch_id
        TEXT event_type
        TEXT summary
    }

    audit {
        INT  id PK
        INT  issue_id FK
        TEXT branch_id
        TEXT tool_name
        TEXT output
    }

    discussions {
        INT  id PK
        INT  issue_id FK
        TEXT author
        TEXT kind
        TEXT body_md
    }

    roundtables {
        INT  id PK
        INT  issue_id FK
        TEXT topic
        TEXT status
    }

    roundtable_votes {
        INT  id PK
        INT  roundtable_id FK
        TEXT agent
        TEXT vote
    }
```

## Relationships (foreign keys declared in schema)

| From | Column | → To | Semantics |
|---|---|---|---|
| `issues` | `parent_issue_id` | `issues.id` | nested issues (rare; self-ref) |
| `issues` | `current_task_id` | `tasks.id` | points at the task currently running; nullable |
| `tasks` | `issue_id` | `issues.id` | every task belongs to one issue |
| `ledger` | `issue_id` | `issues.id` | event row always scoped to an issue |
| `audit` | `issue_id` | `issues.id` | tool output row always scoped to an issue |
| `discussions` | `issue_id` | `issues.id` | architect ↔ human notes per issue |
| `roundtables` | `issue_id` | `issues.id` | a multi-agent debate belongs to an issue |
| `roundtable_votes` | `roundtable_id` | `roundtables.id` | one vote row per agent per roundtable |

## Soft references (no FK, by convention)

| From | Column | → To | Why no FK |
|---|---|---|---|
| `validation_attempts` | `task_id` | `tasks.id` | declared as TEXT historically; should be INTEGER FK. See Stale-item below. |
| `ledger` | `branch_id` | `tasks.branch_id` | `branch_id` is a hierarchy code (`"1.2.3"`), unique only per-issue. FK would need composite. |
| `audit` | `branch_id` | `tasks.branch_id` | same reason. |
| `tasks` | `parent_branch_id` | `tasks.branch_id` (same issue) | same reason — composite FK not declared. |

## Registries (no relationships to workflow tables)

| Table | Purpose |
|---|---|
| `skills` | Registry of curated + agent-created skills with effectiveness stats (`uses`, `successes`, `failures`, `effectiveness`). Looked up by name. |
| `file_registry` | Output of lazy `git log` diff walker. One row per file. Feeds the 4 auto renderers. |
| `plugin_config` | KV for plugin settings (branching model, protected branches, PR target, etc.). See `mcp/trajectory-server/docs/CONFIG_KEYS.md` for canonical key list. |
| `identity` | Single-row table (`CHECK id=1`) holding gatekeeper name + human name. |
| `regen_state` | Per-target cursor (`last_seen_sha`) for the lazy architecture regen. Lets us skip re-scanning unchanged commits. |
| `plugin_meta` | Schema + plugin version for migrations. Current row: `schema_version=5, plugin_version='0.3.0-alpha'`. |

## Indexes

- `idx_tasks_issue_branch` — `UNIQUE(issue_id, branch_id)`. Prevents two tasks sharing the same branch_id within an issue.
- `idx_discussions_issue_created` — `(issue_id, created_at)`. Feeds the chronological discussion view.
- `validation_attempts` has `UNIQUE(task_id, attempt_n)` — one row per (task, attempt).

## Known schema stale items

See `FILES.md` § Stale. Relevant to schema:

1. **`tasks.task_spec_path`** — dead column (Phase 6.5 replacement with `spec_body_md` left the old column in place). Drop via v5→v6 migration.
2. **`validation_attempts.task_id TEXT`** — should be INTEGER FK to `tasks(id)`. Currently loses referential integrity. Worth fixing in the same v5→v6 migration.

## How agents use this

- **gatekeeper** — reads `plugin_config`, `identity`, `issues(status='open')` on session start. Writes `discussions` when relaying human intent.
- **architect** — `issue_create` → `discussion_append` → `task_create_batch(spec_body_md)` → `task_update_status` → `validation_record`.
- **swe** — `task_get(id)` for spec → `ledger_log` / `audit_log` during work → `task_update_status('completed')` on success.
- **pr-reviewer** — `task_list(issue_id, status='completed')` → `validation_record(verdict)` per task.
- **monitors/tmb-trajectory-events.js** — read-only tail of `ledger` for status-line output.

External writers are blocked by MCP tool role-gating (see `middleware/agent-scope.ts` design; current implementation is passthrough with per-tool role checks inside each `tools/*.ts`).
