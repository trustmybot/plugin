# Trajectory DB — Entity Relationship Diagram

SQLite schema (`mcp/trajectory-server/src/schema.sql`, `schema_version = 1` baseline). Persistent at `<cwd>/.claude/<plugin-name>/trajectory.db` — project-local, per-user, gitignored. The `<plugin-name>` segment is the installed plugin's `plugin.json.name` (so stable writes to `tmb/`, RC writes to `tmb-rc/` — channel-isolated per #87). Override with `TRAJECTORY_DB_PATH` for CI / ephemeral runs (`:memory:`, custom file).

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
        TEXT branch_id "git branch: feat/x, fix/y, …"
        TEXT parent_branch_id "git branch of parent task"
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
| `discussions` | `issue_id` | `issues.id` | bro ↔ human ↔ consultants conversation per issue |
| `roundtables` | `issue_id` | `issues.id` | a multi-agent debate belongs to an issue |
| `roundtable_votes` | `roundtable_id` | `roundtables.id` | one vote row per agent per roundtable |
| `validation_attempts` | `task_id` | `tasks.id` | every validation attempt belongs to one task |

## Soft references (no FK, by convention)

`branch_id` is the **git-convention working branch name** (e.g. `feat/user-login`, `fix/null-crash`), enforced via `validateBranchId` in `tools/tasks.ts`. It doubles as the actual git branch SWE creates the worktree on. Tasks are uniquely keyed by `(issue_id, branch_id)` — see the `idx_tasks_issue_branch` UNIQUE INDEX below — so the same `feat/user-login` could in principle exist under two different issues without collision.

| From | Column | → To | Why no FK |
|---|---|---|---|
| `ledger` | `branch_id` | `tasks.branch_id` | `branch_id` alone isn't unique in `tasks` — the UNIQUE constraint is composite `(issue_id, branch_id)`. A composite FK `(issue_id, branch_id)` would work in principle, but `ledger.branch_id` is nullable (some events are issue-scoped, not task-scoped), and nullable composite FKs are awkward. Kept as a soft ref scoped by `ledger.issue_id`. |
| `audit` | `branch_id` | `tasks.branch_id` | Same reason — composite-uniqueness + nullable column. Audit rows are scoped by `audit.issue_id` already. |
| `tasks` | `parent_branch_id` | `tasks.branch_id` (same issue) | Self-reference within an issue. A composite self-FK `(issue_id, parent_branch_id) → (issue_id, branch_id)` is feasible but adds insert-order brittleness; kept soft. |

## Registries (no relationships to workflow tables)

| Table | Purpose |
|---|---|
| `skills` | Registry of curated + agent-created skills with effectiveness stats (`uses`, `successes`, `failures`, `effectiveness`). Looked up by name. |
| `file_registry` | Output of the lazy `git log` diff walker. One row per file. Feeds the 4 auto renderers. |
| `plugin_config` | KV for plugin settings (branching model, protected branches, PR target, etc.). See `mcp/trajectory-server/docs/CONFIG_KEYS.md` for the canonical key list. |
| `identity` | Single-row table (`CHECK id=1`) holding bro name + human name. |
| `regen_state` | Per-target cursor (`last_seen_sha`) for the lazy architecture regen. |
| `plugin_meta` | Schema + plugin version (for future migrations). Current row: `schema_version=1, plugin_version='0.1.2'`. |

## Indexes

- `idx_tasks_issue_branch` — `UNIQUE(issue_id, branch_id)`. Each issue has one task per git branch name; this is also the lookup index for "does this task exist?" checks. Two issues may legitimately have the same `branch_id` (e.g. both have a `feat/user-login` task).
- `idx_discussions_issue_created` — `(issue_id, created_at)`. Feeds the chronological discussion view.
- `validation_attempts` — `UNIQUE(task_id, attempt_n)`. One row per (task, attempt).

## How agents use this

- **bro** (planner + task gate, CLAUDE.md persona on main Claude) — full write access for the workflow side: `identity_get`/`set`, `config_get`/`set`/`list`, `issue_create`/`get`/`resume`/`close`, `discussion_append` (kind='intent'/'note'/'question'/'answer'/'decision'), `task_create_batch`, `task_update_status` (closes tasks after verifying SWE's return), `ledger_log`. Also reads `validation_history` to drive the retry loop (flow 8) and runs `architecture_regen` (flow 7).
- **swe** (executor, project-local subagent in worktree) — `task_get(id)` for spec → `ledger_log` / `audit_log` during work → `task_update_status('completed', commit_sha)` on success. Cannot write to `issues`, `validation_attempts`, or close tasks.
- **pr-reviewer** (push gate, project-local subagent) — `task_get(task_id)` for spec + commit → `validation_record(task_id, attempt_n, verdict, feedback)` to sign off. Only role permitted to write `validation_attempts`. Never writes to `tasks`; the close flip stays bro's call.
- **consultants** (architect, cto, ceo, pm, project-local domain agents) — read-only on workflow tables (`issue_get_with_discussions`, `task_get`, `validation_history`); may write `discussion_append(kind='analysis'|'concern')` to record their position. Server-rejected on `task_create_batch`, `task_update_status`, `validation_record`, `issue_create` via `requireRoles`.

The decision chain (Human → bro → SWE, with pr-reviewer as push gate) is structurally enforced by `requireRoles` middleware inside each `tools/*.ts` family (see `middleware/agent-scope.ts` for `requireRoles`, `AgentRole` type, and the role-by-tool matrix).

## Migrations

None yet. The plugin is pre-release — every install is a fresh DB. `schema.sql` is applied on open via `CREATE TABLE IF NOT EXISTS` and `INSERT OR IGNORE` into `plugin_meta`. Future breaking schema changes will add a `v1 → v2` path in the same release.
