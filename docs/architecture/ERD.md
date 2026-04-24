# Trajectory DB — Entity Relationship Diagram

SQLite schema (`mcp/trajectory-server/src/schema.sql`, `schema_version = 1` baseline). Persistent at `<cwd>/.claude/tmb/trajectory.db` — project-local, per-user, gitignored. Override with `TRAJECTORY_DB_PATH` for CI / ephemeral runs (`:memory:`, custom file).

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

    tasks ||--o{ validation_attempts : "task_id (INTEGER FK)"
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
        TEXT description
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
        TEXT title
        TEXT description
        TEXT tools_required "JSON array"
        TEXT skills_required "JSON array"
        TEXT success_criteria
        TEXT status
        INT  attempts
        TEXT spec_body
        TEXT commit_sha
    }

    validation_attempts {
        INT  id PK
        INT  task_id FK
        INT  attempt_n
        TEXT agent
        TEXT verdict
        TEXT feedback
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
        TEXT from_node
        TEXT tool_name
        TEXT tool_args "JSON"
        TEXT output
        INT  round
    }

    discussions {
        INT  id PK
        INT  issue_id FK
        TEXT author
        TEXT kind
        TEXT body
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
        TEXT rationale
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
| `validation_attempts` | `task_id` | `tasks.id` | every validation attempt belongs to one task |

## Soft references (no FK, by convention)

| From | Column | → To | Why no FK |
|---|---|---|---|
| `ledger` | `branch_id` | `tasks.branch_id` | `branch_id` is a hierarchy code (`"1.2.3"`), unique only per-issue. Composite FK not declared. |
| `audit` | `branch_id` | `tasks.branch_id` | same reason |
| `tasks` | `parent_branch_id` | `tasks.branch_id` (same issue) | same reason |

## Registries (no relationships to workflow tables)

| Table | Purpose |
|---|---|
| `skills` | Registry of curated + agent-created skills with effectiveness stats (`uses`, `successes`, `failures`, `effectiveness`). Looked up by name. |
| `file_registry` | Output of the lazy `git log` diff walker. One row per file. Feeds the 4 auto renderers. |
| `plugin_config` | KV for plugin settings (branching model, protected branches, PR target, etc.). See `mcp/trajectory-server/docs/CONFIG_KEYS.md` for the canonical key list. |
| `identity` | Single-row table (`CHECK id=1`) holding gatekeeper name + human name. |
| `regen_state` | Per-target cursor (`last_seen_sha`) for the lazy architecture regen. |
| `plugin_meta` | Schema + plugin version (for future migrations). Current row: `schema_version=1, plugin_version='0.3.2'`. |

## Indexes

- `idx_tasks_issue_branch` — `UNIQUE(issue_id, branch_id)`. Prevents two tasks sharing the same branch_id within an issue.
- `idx_discussions_issue_created` — `(issue_id, created_at)`. Feeds the chronological discussion view.
- `validation_attempts` — `UNIQUE(task_id, attempt_n)`. One row per (task, attempt).

## How agents use this

- **gatekeeper** — reads `plugin_config`, `identity`, `issues(status='open')` on session start. Writes `discussions` when relaying human intent.
- **architect** — `issue_create` → `discussion_append` → `task_create_batch(spec_body)` → `task_update_status` → `validation_record`. Also edits agent prompts, skill files, and workflow markdown when they drift (see `skills/docs-conventions` prompt-editing rules).
- **swe** — `task_get(id)` for spec → `ledger_log` / `audit_log` during work → `task_update_status('completed')` on success.
- **pr-reviewer** — `task_get(task_id)` to inspect the spec + status of the task passed in the spawn → `validation_record(task_id, attempt_n, verdict, feedback)` to sign off. Never writes to `tasks`; status flip to `closed` is the architect's call.
- **monitors/tmb-trajectory-events.js** — read-only tail of `ledger` for status-line output.

External writers are blocked by role-gating inside each `tools/*.ts` family (see `middleware/agent-scope.ts` for `requireRoles` + `AgentRole` type).

## Migrations

None yet. The plugin is pre-release — every install is a fresh DB. `schema.sql` is applied on open via `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` into `plugin_meta`. Future breaking schema changes will add a `v1 → v2` path in the same release.
