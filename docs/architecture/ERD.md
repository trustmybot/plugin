# Trajectory DB — Entity Relationship Diagram

SQLite schema (`mcp/trajectory-server/src/schema.sql`, `schema_version = 72`). One DB per project at `<project-root>/.claude/<plugin-name>/trajectory.db` — project-local, per user, gitignored; [Where the trajectory DB lives](../reference/TRAJECTORY_DB_LOCATION.md) gives the lookup rule, and `TRAJECTORY_DB_PATH` overrides it for CI and ephemeral runs.

## Overview

The DB is TMB's cold memory ([`MEMORY.md`](./MEMORY.md)): the only source of truth for workflow state, read and written through the trajectory server and its hooks. Its tables fall into five groups:

- **Workflow** — the issue → task chain and everything recorded against it: decisions and discussions, the audit log, verification runs, review verdicts and findings, metered agent runs, roundtables and session handoffs. Every row hangs off an issue or a task.
- **Registries** — standalone state not tied to an issue: registered repos with their per-repo branch policy, remotes and toolchain profiles; milestones; agents; capabilities (cheatcodes) and what each install wired; PR records; plugin config and schema metadata.
- **World model** — the project map (directories, files, symbols, the edges between them, concepts) and its freshness state. A derived cache, keyed by repo and rebuilt by scanning, with no foreign key into the workflow tables.
- **Search** — FTS5 indexes and embedding caches over discussions, audit rows and the world model, each keyed by its source row.
- **Eval mode** — capture tables in `schema-eval.sql`, applied only with `TMB_EVAL_MODE=1`, so production DBs never carry them.

The tables, columns, foreign keys, search indexes and indexes below are generated from `schema.sql` by `scripts/maintenance/gen-erd-doc.mjs`; `tests/l1-lint/erd-doc-fresh.test.mjs` fails when they drift. The prose around them is hand-written and stays at the level of groups and rules: what a column means is in `schema.sql`, and who writes it is in the tools under `mcp/trajectory-server/src/tools/` (`world_model_search` finds the writer).

<!-- erd:generated:start -->
_Generated from `mcp/trajectory-server/src/schema.sql` by `scripts/maintenance/gen-erd-doc.mjs` at `schema_version = 72`; edit the schema, then rerun the script._

## Diagram

```mermaid
erDiagram
    repos ||--o{ repo_remotes : "repo (CASCADE)"
    repos ||--o{ repo_env : "repo (CASCADE)"
    repos |o--o| wm_freshness : "repo (CASCADE)"
    repos ||--o{ milestones : "repo (RESTRICT)"
    repos |o--o{ issues : "repo (RESTRICT)"
    milestones |o--o{ issues : "milestone, repo (RESTRICT)"
    issues ||--o{ tasks : "issue_id (NO ACTION)"
    repos |o--o{ tasks : "repo (RESTRICT)"
    issues ||--o{ audit : "issue_id (NO ACTION)"
    repos |o--o{ audit : "repo (RESTRICT)"
    tasks ||--o{ validation_attempts : "task_id (NO ACTION)"
    repos |o--o{ validation_attempts : "repo (RESTRICT)"
    tasks ||--o{ verification_runs : "task_id (CASCADE)"
    verification_runs ||--o{ verification_run_commands : "run_id (CASCADE)"
    tasks ||--o{ lint_runs : "task_id (CASCADE)"
    lint_runs ||--o{ lint_run_results : "run_id (CASCADE)"
    tasks ||--o{ review_findings : "task_id (CASCADE)"
    issues ||--o{ roundtables : "issue_id (NO ACTION)"
    roundtables ||--o{ roundtable_votes : "roundtable_id (NO ACTION)"
    issues ||--o{ discussions : "issue_id (NO ACTION)"
    repos |o--o{ discussions : "repo (RESTRICT)"
    tasks |o--o{ discussions : "task_id (NO ACTION)"
    discussions |o--o{ discussions : "supersedes (NO ACTION)"
    tasks |o--o{ agent_runs : "task_id (NO ACTION)"
    issues |o--o{ agent_runs : "issue_id (NO ACTION)"
    repos |o--o{ agent_runs : "repo (RESTRICT)"
    agent_runs |o--o{ agent_runs : "resumed_from (NO ACTION)"
    issues |o--o{ session_handoffs : "issue_id (NO ACTION)"
    agent_runs ||--o{ agent_run_tool_output : "run_id (CASCADE)"
    tasks |o--o{ pr_review_runs : "task_id (NO ACTION)"
    prs ||--o{ pr_closes : "pr_id (CASCADE)"
    discussions ||--o| discussions_embeddings : "discussion_id (CASCADE)"
    audit ||--o| audit_embeddings : "audit_id (CASCADE)"
    cheatcodes ||--o{ cheatcode_attachments : "cheatcode_id (CASCADE)"
    wm_symbols ||--o{ wm_edges : "src_id (CASCADE)"
    wm_symbols |o--o{ wm_edges : "dst_id (SET NULL)"
    wm_concepts ||--o{ wm_concept_steps : "concept_id (CASCADE)"
    wm_concepts ||--o{ wm_concept_claims : "concept_id (CASCADE)"
    wm_directories ||--o| wm_directories_embeddings : "dir_id (CASCADE)"
    wm_files ||--o| wm_files_embeddings : "file_id (CASCADE)"

    repos {
        TEXT name PK
        TEXT path "NOT NULL"
        INTEGER file_count "NOT NULL"
        TEXT last_scanned_at "NOT NULL"
        TEXT target_branch
        TEXT branching_model
        TEXT protected_branches
        TEXT onboard_scan
        TEXT indexed_commit
        TEXT indexed_stamp
    }

    repo_remotes {
        TEXT repo PK,FK "NOT NULL; → repos.name CASCADE"
        TEXT name PK "NOT NULL"
        TEXT provider "NOT NULL; CHECK github|gitlab|other"
        TEXT url "NOT NULL"
        INTEGER is_primary "NOT NULL; CHECK is_primary IN (0,1)"
        TEXT created_at "NOT NULL"
        INTEGER sync "NOT NULL; CHECK sync IN (0,1)"
    }

    repo_env {
        INTEGER id PK "NOT NULL"
        TEXT repo FK "NOT NULL; → repos.name CASCADE"
        TEXT package_path "NOT NULL"
        TEXT ecosystem "NOT NULL"
        TEXT package_manager "NOT NULL"
        TEXT runner_prefix
        TEXT commands_json "NOT NULL"
        TEXT globs_json "NOT NULL"
        TEXT status "NOT NULL; CHECK ready|detected|missing_tool|stale"
        TEXT confirmed_by
        TEXT detected_at "NOT NULL"
        TEXT evidence_hash "NOT NULL"
        TEXT overrides_json
        TEXT waivers_json
        TEXT declined_json
        TEXT updated_at "NOT NULL"
    }

    wm_freshness {
        TEXT repo PK,FK "→ repos.name CASCADE"
        TEXT target_ref
        TEXT target_commit
        TEXT target_fetched_at
        TEXT reindex_state "NOT NULL; CHECK idle|running|failed"
        TEXT reindex_mode "CHECK incremental|full"
        TEXT reindex_trigger "CHECK read|spawn|startup|scan|hook|fetch"
        TEXT reindex_started_at
        TEXT reindex_finished_at
        INTEGER reindex_elapsed_ms
        TEXT reindex_outcome "CHECK ok|error"
        TEXT updated_at "NOT NULL"
    }

    milestones {
        TEXT name PK "NOT NULL"
        TEXT repo PK,FK "NOT NULL; → repos.name RESTRICT"
        TEXT state "NOT NULL; CHECK open|closed"
    }

    issues {
        INTEGER id PK "NOT NULL"
        TEXT objective "NOT NULL"
        TEXT description "NOT NULL"
        TEXT status "NOT NULL; CHECK open|closed"
        TEXT created_at "NOT NULL"
        TEXT updated_at "NOT NULL"
        TEXT closed_at
        TEXT remote_kind "CHECK github|gitlab"
        INTEGER gh_iid
        INTEGER gl_iid
        TEXT repo FK "→ repos.name RESTRICT; → milestones.repo RESTRICT"
        TEXT milestone FK "→ milestones.name RESTRICT"
        TEXT labels
    }

    tasks {
        INTEGER id PK "NOT NULL"
        INTEGER issue_id FK "NOT NULL; → issues.id NO ACTION"
        TEXT branch_id "NOT NULL"
        TEXT parent_branch_id
        TEXT title "NOT NULL"
        TEXT description "NOT NULL"
        TEXT status "NOT NULL; CHECK pending|running|needs_validation|completed|closed|failed|escalated"
        TEXT spec_body "NOT NULL"
        TEXT commit_sha
        TEXT repo FK "→ repos.name RESTRICT"
        INTEGER prompt_bearing "NOT NULL"
        TEXT files "NOT NULL"
        TEXT verification "NOT NULL"
        TEXT created_at "NOT NULL"
        TEXT updated_at "NOT NULL"
        TEXT completed_at
        TEXT effort "NOT NULL; CHECK low|medium|high"
        TEXT completion_report
        TEXT spawn_note
        TEXT checkpoint
        TEXT worktree_path
        INTEGER worktree_adopted "NOT NULL; CHECK worktree_adopted IN (0,1)"
        TEXT workflow_mode "CHECK workflow_mode IS NULL OR workflow_mode IN ('truest','agile')"
        TEXT base_sha
        TEXT wm_commit
        TEXT no_code_class "CHECK no_code_class IS NULL OR no_code_class IN ('docs','prompts')"
    }

    audit {
        INTEGER id PK "NOT NULL"
        INTEGER issue_id FK "NOT NULL; → issues.id NO ACTION"
        TEXT branch_id
        TEXT from_node "NOT NULL"
        TEXT event_type "NOT NULL"
        TEXT summary "NOT NULL"
        TEXT content_json "NOT NULL"
        TEXT repo FK "→ repos.name RESTRICT"
        TEXT created_at "NOT NULL"
    }

    validation_attempts {
        INTEGER id PK "NOT NULL"
        INTEGER task_id FK "NOT NULL; → tasks.id NO ACTION"
        INTEGER attempt_n "NOT NULL"
        TEXT agent "NOT NULL"
        TEXT verdict "NOT NULL; CHECK pass|fail|escalate"
        TEXT feedback "NOT NULL"
        INTEGER mcp_available "NOT NULL"
        TEXT subagent_session_id
        TEXT repo FK "→ repos.name RESTRICT"
        TEXT created_at "NOT NULL"
        TEXT reviewer_agent_id
        TEXT reviewed_sha
        TEXT probes_json
    }

    verification_runs {
        INTEGER id PK "NOT NULL"
        INTEGER task_id FK "NOT NULL; → tasks.id CASCADE"
        TEXT commit_sha "NOT NULL"
        TEXT source "NOT NULL; CHECK gate|manual"
        TEXT started_at "NOT NULL"
        TEXT finished_at
        INTEGER exit_code
        INTEGER budget_s "NOT NULL"
        INTEGER timed_out "NOT NULL; CHECK timed_out IN (0,1)"
        TEXT created_at "NOT NULL"
    }

    verification_run_commands {
        INTEGER run_id PK,FK "NOT NULL; → verification_runs.id CASCADE"
        INTEGER ordinal PK "NOT NULL"
        TEXT command "NOT NULL"
        INTEGER exit_code
        REAL elapsed_s
        TEXT output_tail
    }

    lint_runs {
        INTEGER id PK "NOT NULL"
        INTEGER task_id FK "NOT NULL; → tasks.id CASCADE"
        TEXT commit_sha "NOT NULL"
        TEXT base_sha "NOT NULL"
        TEXT fingerprint "NOT NULL"
        TEXT source "NOT NULL; CHECK gate|integrate"
        TEXT started_at "NOT NULL"
        TEXT finished_at
        INTEGER exit_code
        TEXT created_at "NOT NULL"
    }

    lint_run_results {
        INTEGER run_id PK,FK "NOT NULL; → lint_runs.id CASCADE"
        INTEGER ordinal PK "NOT NULL"
        TEXT name "NOT NULL"
        INTEGER exit_code
        REAL elapsed_s
        TEXT output_tail
    }

    review_findings {
        TEXT id PK
        INTEGER task_id FK "NOT NULL; → tasks.id CASCADE"
        INTEGER attempt_n "NOT NULL"
        TEXT criterion_id
        TEXT probe_cmd "NOT NULL"
        TEXT expected "NOT NULL"
        TEXT observed "NOT NULL"
        TEXT status "NOT NULL; CHECK open|fixed|wontfix"
        TEXT created_at "NOT NULL"
        TEXT resolved_at
        TEXT severity "NOT NULL; CHECK blocking|nit|pre_existing"
        TEXT class
    }

    agents {
        INTEGER id PK "NOT NULL"
        TEXT name UK "NOT NULL"
        TEXT kind "NOT NULL; CHECK backbone|consultant"
        TEXT file_path "NOT NULL; CHECK file_path LIKE 'plugin:%' OR file_path LIKE 'project:%'"
        TEXT created_at "NOT NULL"
        TEXT updated_at "NOT NULL"
    }

    roundtables {
        INTEGER id PK "NOT NULL"
        INTEGER issue_id FK "NOT NULL; → issues.id NO ACTION"
        TEXT topic "NOT NULL"
        TEXT outcome "NOT NULL"
        TEXT created_at "NOT NULL"
        TEXT closed_at
        TEXT state "NOT NULL; CHECK collecting|awaiting_human|closed|skipped"
        INTEGER expected_participants
    }

    roundtable_votes {
        INTEGER id PK "NOT NULL"
        INTEGER roundtable_id FK "NOT NULL; → roundtables.id NO ACTION"
        TEXT participant "NOT NULL"
        TEXT vote "NOT NULL"
        TEXT rationale "NOT NULL"
        TEXT created_at "NOT NULL"
    }

    discussions {
        INTEGER id PK "NOT NULL"
        INTEGER issue_id FK "NOT NULL; → issues.id NO ACTION"
        TEXT author "NOT NULL"
        TEXT kind "NOT NULL; CHECK intent|question|answer|decision|note|analysis"
        TEXT body "NOT NULL"
        TEXT repo FK "→ repos.name RESTRICT"
        TEXT created_at "NOT NULL"
        TEXT remote_comment_id
        INTEGER task_id FK "→ tasks.id NO ACTION"
        INTEGER supersedes FK "→ discussions.id NO ACTION"
    }

    plugin_meta {
        INTEGER id PK "NOT NULL"
        INTEGER schema_version "NOT NULL"
        TEXT plugin_version "NOT NULL"
    }

    plugin_config {
        TEXT key PK
        TEXT value_json "NOT NULL"
    }

    agent_runs {
        INTEGER id PK "NOT NULL"
        INTEGER task_id FK "→ tasks.id NO ACTION"
        INTEGER issue_id FK "→ issues.id NO ACTION"
        TEXT agent_type "NOT NULL"
        INTEGER tokens_in
        INTEGER tokens_out
        INTEGER cache_read_tokens
        INTEGER cache_creation_tokens
        INTEGER tool_uses "NOT NULL"
        INTEGER duration_ms "NOT NULL"
        TEXT started_at
        TEXT completed_at
        TEXT repo FK "→ repos.name RESTRICT"
        TEXT spawn_id
        TEXT session_id
        TEXT usage_source "CHECK transcript|subagent_stop|unmeasured|backfill"
        TEXT root_dir
        TEXT model
        TEXT host "CHECK claude|codex"
        TEXT exit_reason "CHECK completed|failed|escalated|swept_orphan|swept_stale|issue_closed"
        TEXT effort "CHECK low|medium|high"
        INTEGER resumed_from FK "→ agent_runs.id NO ACTION"
        TEXT plugin_version
        TEXT stop_cause "CHECK budget|hook_block"
        TEXT stop_detail
        INTEGER hook_block_tokens
    }

    session_handoffs {
        TEXT session_id PK
        TEXT cwd "NOT NULL"
        INTEGER issue_id FK "→ issues.id NO ACTION"
        TEXT summary
        TEXT created_at "NOT NULL"
        TEXT updated_at "NOT NULL"
        TEXT consumed_at
        TEXT consumed_by_session
    }

    agent_run_tool_output {
        INTEGER id PK "NOT NULL"
        INTEGER run_id FK "NOT NULL; → agent_runs.id CASCADE"
        TEXT tool_name "NOT NULL"
        INTEGER calls "NOT NULL"
        INTEGER result_chars "NOT NULL"
        INTEGER est_tokens "NOT NULL"
    }

    pr_review_runs {
        INTEGER id PK "NOT NULL"
        INTEGER pr_number "NOT NULL; CHECK pr_number > 0"
        TEXT repo "NOT NULL; CHECK repo <> ''"
        DATETIME last_fetched_at "NOT NULL"
        TEXT last_comment_id
        INTEGER task_id FK "→ tasks.id NO ACTION"
    }

    prs {
        INTEGER id PK "NOT NULL"
        TEXT repo "NOT NULL"
        INTEGER number "NOT NULL; CHECK number > 0"
        TEXT state "NOT NULL; CHECK open|closed|merged"
        DATETIME created_at "NOT NULL"
        DATETIME merged_at
        DATETIME updated_at "NOT NULL"
        DATETIME synced_at "NOT NULL"
    }

    pr_closes {
        INTEGER pr_id PK,FK "NOT NULL; → prs.id CASCADE"
        INTEGER issue_number PK "NOT NULL; CHECK issue_number > 0"
    }

    discussions_embeddings {
        INTEGER discussion_id PK,FK "NOT NULL; → discussions.id CASCADE"
        BLOB embedding "NOT NULL"
        TEXT model_id "NOT NULL"
        TEXT embedded_at "NOT NULL"
    }

    audit_embeddings {
        INTEGER audit_id PK,FK "NOT NULL; → audit.id CASCADE"
        BLOB embedding "NOT NULL"
        TEXT model_id "NOT NULL"
        TEXT embedded_at "NOT NULL"
    }

    cheatcodes {
        INTEGER id PK "NOT NULL"
        TEXT name "NOT NULL"
        TEXT kind "NOT NULL; CHECK skill|mcp|plugin"
        TEXT origin "NOT NULL; CHECK builtin|marketplace|external"
        TEXT description "NOT NULL"
        TEXT source_url
        TEXT file_path
        TEXT version
        TEXT trust_tier
        TEXT scope "NOT NULL; CHECK global|template|project-local"
        TEXT status "NOT NULL"
        TEXT installed_at "NOT NULL"
        TEXT created_at "NOT NULL"
        TEXT updated_at "NOT NULL"
    }

    cheatcode_attachments {
        INTEGER id PK "NOT NULL"
        INTEGER cheatcode_id FK "NOT NULL; → cheatcodes.id CASCADE"
        TEXT target "NOT NULL"
        TEXT artifact "NOT NULL"
        TEXT created_at "NOT NULL"
    }

    wm_directories {
        INTEGER id PK "NOT NULL"
        TEXT repo "NOT NULL"
        TEXT path "NOT NULL"
        TEXT parent_path
        TEXT summary
        TEXT summary_source "NOT NULL"
        TEXT summary_updated_at
        INTEGER file_count "NOT NULL"
        TEXT summary_sha
        INTEGER commits_behind
        TEXT dead_refs
        INTEGER readme_review_pending "NOT NULL"
    }

    wm_files {
        INTEGER id PK "NOT NULL"
        TEXT repo "NOT NULL"
        TEXT path "NOT NULL"
        TEXT dir "NOT NULL"
        TEXT purpose "NOT NULL"
        TEXT purpose_source "NOT NULL"
        TEXT content_md5 "NOT NULL"
        INTEGER size_bytes "NOT NULL"
        TEXT last_commit_sha "NOT NULL"
        TEXT updated_at "NOT NULL"
        TEXT symbols_md5
        TEXT lane "NOT NULL; CHECK test|product"
    }

    wm_symbols {
        INTEGER id PK "NOT NULL"
        TEXT repo "NOT NULL"
        TEXT path "NOT NULL"
        TEXT kind "NOT NULL; CHECK function|method|class|interface|type|const|sh_function|sql_table|sql_index|sql_trigger|module|hook|runner"
        TEXT qualified_name "NOT NULL"
        TEXT signature "NOT NULL"
        TEXT doc "NOT NULL"
        INTEGER start_line
        INTEGER end_line
        TEXT body_hash "NOT NULL"
        INTEGER exported "NOT NULL"
        TEXT terms "NOT NULL"
        INTEGER run_order
    }

    wm_edges {
        INTEGER src_id FK "NOT NULL; → wm_symbols.id CASCADE"
        INTEGER dst_id FK "→ wm_symbols.id SET NULL"
        TEXT dst_name "NOT NULL"
        TEXT kind "NOT NULL; CHECK calls|imports|instantiates|sources|runs|reads_table|writes_table|indexes|triggers_on|bundles|reads_config|covers"
        TEXT resolution "NOT NULL; CHECK exact|name|unresolved"
        INTEGER line
        TEXT hint
    }

    wm_concepts {
        INTEGER id PK "NOT NULL"
        TEXT repo "NOT NULL"
        TEXT kind "NOT NULL; CHECK flow|subsystem|invariant"
        TEXT name "NOT NULL"
        TEXT body "NOT NULL"
        TEXT status "NOT NULL; CHECK verified|suspect|broken|retired"
        TEXT status_reason
        TEXT verified_sha
        TEXT verified_by
        TEXT verified_at
        TEXT created_at "NOT NULL"
        TEXT updated_at "NOT NULL"
        TEXT steps_text "NOT NULL"
    }

    wm_concept_steps {
        INTEGER concept_id PK,FK "NOT NULL; → wm_concepts.id CASCADE"
        INTEGER ordinal PK "NOT NULL"
        TEXT repo "NOT NULL"
        TEXT path "NOT NULL"
        TEXT kind "NOT NULL"
        TEXT qualified_name "NOT NULL"
        TEXT description "NOT NULL"
        TEXT handoff "CHECK calls|sources|runs|hook_fires"
        TEXT hash_at_verify "NOT NULL"
        TEXT trust "NOT NULL; CHECK verified|suspect|broken"
        TEXT trust_reason
    }

    wm_concept_claims {
        INTEGER id PK "NOT NULL"
        INTEGER concept_id FK "NOT NULL; → wm_concepts.id CASCADE"
        TEXT claim "NOT NULL; CHECK exists|calls|only_writers_of|tested_by"
        TEXT args "NOT NULL"
        TEXT last_result
    }

    wm_directories_embeddings {
        INTEGER dir_id PK,FK "NOT NULL; → wm_directories.id CASCADE"
        BLOB embedding "NOT NULL"
        TEXT model_id "NOT NULL"
        TEXT embedded_at "NOT NULL"
    }

    wm_files_embeddings {
        INTEGER file_id PK,FK "NOT NULL; → wm_files.id CASCADE"
        BLOB embedding "NOT NULL"
        TEXT model_id "NOT NULL"
        TEXT embedded_at "NOT NULL"
    }
```

## Tables

### `repos`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `name` | TEXT | nullable |  | PK |
| `path` | TEXT | NOT NULL |  |  |
| `file_count` | INTEGER | NOT NULL | `0` |  |
| `last_scanned_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |
| `target_branch` | TEXT | nullable |  |  |
| `branching_model` | TEXT | nullable |  |  |
| `protected_branches` | TEXT | nullable |  |  |
| `onboard_scan` | TEXT | nullable |  |  |
| `indexed_commit` | TEXT | nullable |  |  |
| `indexed_stamp` | TEXT | nullable |  |  |

### `repo_remotes`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `repo` | TEXT | NOT NULL |  | FK → `repos.name` ON DELETE CASCADE |
| `name` | TEXT | NOT NULL |  |  |
| `provider` | TEXT | NOT NULL |  | CHECK `provider IN ('github','gitlab','other')` |
| `url` | TEXT | NOT NULL |  |  |
| `is_primary` | INTEGER | NOT NULL | `0` | CHECK `is_primary IN (0,1)` |
| `created_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |
| `sync` | INTEGER | NOT NULL | `0` | CHECK `sync IN (0,1)` |

Table constraints:

- PRIMARY KEY `(repo, name)`

### `repo_env`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `repo` | TEXT | NOT NULL |  | FK → `repos.name` ON DELETE CASCADE |
| `package_path` | TEXT | NOT NULL |  |  |
| `ecosystem` | TEXT | NOT NULL |  |  |
| `package_manager` | TEXT | NOT NULL |  |  |
| `runner_prefix` | TEXT | nullable |  |  |
| `commands_json` | TEXT | NOT NULL |  |  |
| `globs_json` | TEXT | NOT NULL |  |  |
| `status` | TEXT | NOT NULL |  | CHECK `status IN ('ready','detected','missing_tool','stale')` |
| `confirmed_by` | TEXT | nullable |  |  |
| `detected_at` | TEXT | NOT NULL |  |  |
| `evidence_hash` | TEXT | NOT NULL |  |  |
| `overrides_json` | TEXT | nullable |  |  |
| `waivers_json` | TEXT | nullable |  |  |
| `declined_json` | TEXT | nullable |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |

Table constraints:

- UNIQUE `(repo, package_path, ecosystem)`

### `wm_freshness`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `repo` | TEXT | nullable |  | PK; FK → `repos.name` ON DELETE CASCADE |
| `target_ref` | TEXT | nullable |  |  |
| `target_commit` | TEXT | nullable |  |  |
| `target_fetched_at` | TEXT | nullable |  |  |
| `reindex_state` | TEXT | NOT NULL | `'idle'` | CHECK `reindex_state IN ('idle','running','failed')` |
| `reindex_mode` | TEXT | nullable |  | CHECK `reindex_mode IN ('incremental','full')` |
| `reindex_trigger` | TEXT | nullable |  | CHECK `reindex_trigger IN ('read','spawn','startup','scan','hook','fetch')` |
| `reindex_started_at` | TEXT | nullable |  |  |
| `reindex_finished_at` | TEXT | nullable |  |  |
| `reindex_elapsed_ms` | INTEGER | nullable |  |  |
| `reindex_outcome` | TEXT | nullable |  | CHECK `reindex_outcome IN ('ok','error')` |
| `updated_at` | TEXT | NOT NULL |  |  |

### `milestones`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `name` | TEXT | NOT NULL |  |  |
| `repo` | TEXT | NOT NULL |  | FK → `repos.name` ON DELETE RESTRICT |
| `state` | TEXT | NOT NULL | `'open'` | CHECK `state IN ('open','closed')` |

Table constraints:

- PRIMARY KEY `(name, repo)`

### `issues`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `objective` | TEXT | NOT NULL |  |  |
| `description` | TEXT | NOT NULL | `''` |  |
| `status` | TEXT | NOT NULL | `'open'` | CHECK `status IN ('open','closed')` |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |
| `closed_at` | TEXT | nullable |  |  |
| `remote_kind` | TEXT | nullable |  | CHECK `remote_kind IN ('github','gitlab')` |
| `gh_iid` | INTEGER | nullable |  |  |
| `gl_iid` | INTEGER | nullable |  |  |
| `repo` | TEXT | nullable |  | FK → `repos.name` ON DELETE RESTRICT |
| `milestone` | TEXT | nullable |  |  |
| `labels` | TEXT | nullable |  |  |

Table constraints:

- FOREIGN KEY `(milestone, repo)` → `milestones(name, repo)` ON DELETE RESTRICT

### `tasks`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `issue_id` | INTEGER | NOT NULL |  | FK → `issues.id` ON DELETE NO ACTION |
| `branch_id` | TEXT | NOT NULL |  |  |
| `parent_branch_id` | TEXT | nullable |  |  |
| `title` | TEXT | NOT NULL | `''` |  |
| `description` | TEXT | NOT NULL |  |  |
| `status` | TEXT | NOT NULL | `'pending'` | CHECK `status IN ('pending','running','needs_validation','completed','closed','failed','escalated')` |
| `spec_body` | TEXT | NOT NULL | `''` |  |
| `commit_sha` | TEXT | nullable |  |  |
| `repo` | TEXT | nullable |  | FK → `repos.name` ON DELETE RESTRICT |
| `prompt_bearing` | INTEGER | NOT NULL | `0` |  |
| `files` | TEXT | NOT NULL | `'[]'` |  |
| `verification` | TEXT | NOT NULL | `'[]'` |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |
| `completed_at` | TEXT | nullable |  |  |
| `effort` | TEXT | NOT NULL | `'medium'` | CHECK `effort IN ('low','medium','high')` |
| `completion_report` | TEXT | nullable |  |  |
| `spawn_note` | TEXT | nullable |  |  |
| `checkpoint` | TEXT | nullable |  |  |
| `worktree_path` | TEXT | nullable |  |  |
| `worktree_adopted` | INTEGER | NOT NULL | `0` | CHECK `worktree_adopted IN (0,1)` |
| `workflow_mode` | TEXT | nullable |  | CHECK `workflow_mode IS NULL OR workflow_mode IN ('truest','agile')` |
| `base_sha` | TEXT | nullable |  |  |
| `wm_commit` | TEXT | nullable |  |  |
| `no_code_class` | TEXT | nullable |  | CHECK `no_code_class IS NULL OR no_code_class IN ('docs','prompts')` |

### `audit`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `issue_id` | INTEGER | NOT NULL |  | FK → `issues.id` ON DELETE NO ACTION |
| `branch_id` | TEXT | nullable |  |  |
| `from_node` | TEXT | NOT NULL | `'executor'` |  |
| `event_type` | TEXT | NOT NULL |  |  |
| `summary` | TEXT | NOT NULL |  |  |
| `content_json` | TEXT | NOT NULL | `'{}'` |  |
| `repo` | TEXT | nullable |  | FK → `repos.name` ON DELETE RESTRICT |
| `created_at` | TEXT | NOT NULL |  |  |

### `validation_attempts`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `task_id` | INTEGER | NOT NULL |  | FK → `tasks.id` ON DELETE NO ACTION |
| `attempt_n` | INTEGER | NOT NULL |  |  |
| `agent` | TEXT | NOT NULL | `''` |  |
| `verdict` | TEXT | NOT NULL |  | CHECK `verdict IN ('pass','fail','escalate')` |
| `feedback` | TEXT | NOT NULL | `''` |  |
| `mcp_available` | INTEGER | NOT NULL |  |  |
| `subagent_session_id` | TEXT | nullable |  |  |
| `repo` | TEXT | nullable |  | FK → `repos.name` ON DELETE RESTRICT |
| `created_at` | TEXT | NOT NULL |  |  |
| `reviewer_agent_id` | TEXT | nullable |  |  |
| `reviewed_sha` | TEXT | nullable |  |  |
| `probes_json` | TEXT | nullable |  |  |

Table constraints:

- UNIQUE `(task_id, attempt_n)`

### `verification_runs`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK |
| `task_id` | INTEGER | NOT NULL |  | FK → `tasks.id` ON DELETE CASCADE |
| `commit_sha` | TEXT | NOT NULL |  |  |
| `source` | TEXT | NOT NULL |  | CHECK `source IN ('gate','manual')` |
| `started_at` | TEXT | NOT NULL |  |  |
| `finished_at` | TEXT | nullable |  |  |
| `exit_code` | INTEGER | nullable |  |  |
| `budget_s` | INTEGER | NOT NULL |  |  |
| `timed_out` | INTEGER | NOT NULL | `0` | CHECK `timed_out IN (0,1)` |
| `created_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |

### `verification_run_commands`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `run_id` | INTEGER | NOT NULL |  | FK → `verification_runs.id` ON DELETE CASCADE |
| `ordinal` | INTEGER | NOT NULL |  |  |
| `command` | TEXT | NOT NULL |  |  |
| `exit_code` | INTEGER | nullable |  |  |
| `elapsed_s` | REAL | nullable |  |  |
| `output_tail` | TEXT | nullable |  |  |

Table constraints:

- PRIMARY KEY `(run_id, ordinal)`

### `lint_runs`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK |
| `task_id` | INTEGER | NOT NULL |  | FK → `tasks.id` ON DELETE CASCADE |
| `commit_sha` | TEXT | NOT NULL |  |  |
| `base_sha` | TEXT | NOT NULL |  |  |
| `fingerprint` | TEXT | NOT NULL |  |  |
| `source` | TEXT | NOT NULL |  | CHECK `source IN ('gate','integrate')` |
| `started_at` | TEXT | NOT NULL |  |  |
| `finished_at` | TEXT | nullable |  |  |
| `exit_code` | INTEGER | nullable |  |  |
| `created_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |

### `lint_run_results`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `run_id` | INTEGER | NOT NULL |  | FK → `lint_runs.id` ON DELETE CASCADE |
| `ordinal` | INTEGER | NOT NULL |  |  |
| `name` | TEXT | NOT NULL |  |  |
| `exit_code` | INTEGER | nullable |  |  |
| `elapsed_s` | REAL | nullable |  |  |
| `output_tail` | TEXT | nullable |  |  |

Table constraints:

- PRIMARY KEY `(run_id, ordinal)`

### `review_findings`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | TEXT | nullable |  | PK |
| `task_id` | INTEGER | NOT NULL |  | FK → `tasks.id` ON DELETE CASCADE |
| `attempt_n` | INTEGER | NOT NULL |  |  |
| `criterion_id` | TEXT | nullable |  |  |
| `probe_cmd` | TEXT | NOT NULL |  |  |
| `expected` | TEXT | NOT NULL |  |  |
| `observed` | TEXT | NOT NULL |  |  |
| `status` | TEXT | NOT NULL | `'open'` | CHECK `status IN ('open','fixed','wontfix')` |
| `created_at` | TEXT | NOT NULL |  |  |
| `resolved_at` | TEXT | nullable |  |  |
| `severity` | TEXT | NOT NULL | `'blocking'` | CHECK `severity IN ('blocking','nit','pre_existing')` |
| `class` | TEXT | nullable |  |  |

### `agents`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `name` | TEXT | NOT NULL |  | UNIQUE |
| `kind` | TEXT | NOT NULL |  | CHECK `kind IN ('backbone','consultant')` |
| `file_path` | TEXT | NOT NULL |  | CHECK `file_path LIKE 'plugin:%' OR file_path LIKE 'project:%'` |
| `created_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |
| `updated_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |

### `roundtables`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `issue_id` | INTEGER | NOT NULL |  | FK → `issues.id` ON DELETE NO ACTION |
| `topic` | TEXT | NOT NULL |  |  |
| `outcome` | TEXT | NOT NULL | `''` |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `closed_at` | TEXT | nullable |  |  |
| `state` | TEXT | NOT NULL | `'collecting'` | CHECK `state IN ('collecting','awaiting_human','closed','skipped')` |
| `expected_participants` | INTEGER | nullable |  |  |

### `roundtable_votes`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `roundtable_id` | INTEGER | NOT NULL |  | FK → `roundtables.id` ON DELETE NO ACTION |
| `participant` | TEXT | NOT NULL |  |  |
| `vote` | TEXT | NOT NULL |  |  |
| `rationale` | TEXT | NOT NULL | `''` |  |
| `created_at` | TEXT | NOT NULL |  |  |

### `discussions`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `issue_id` | INTEGER | NOT NULL |  | FK → `issues.id` ON DELETE NO ACTION |
| `author` | TEXT | NOT NULL |  |  |
| `kind` | TEXT | NOT NULL | `'note'` | CHECK `kind IN ('intent','question','answer','decision','note','analysis')` |
| `body` | TEXT | NOT NULL |  |  |
| `repo` | TEXT | nullable |  | FK → `repos.name` ON DELETE RESTRICT |
| `created_at` | TEXT | NOT NULL |  |  |
| `remote_comment_id` | TEXT | nullable |  |  |
| `task_id` | INTEGER | nullable |  | FK → `tasks.id` ON DELETE NO ACTION |
| `supersedes` | INTEGER | nullable |  | FK → `discussions.id` ON DELETE NO ACTION |

### `plugin_meta`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `schema_version` | INTEGER | NOT NULL |  |  |
| `plugin_version` | TEXT | NOT NULL |  |  |

### `plugin_config`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `key` | TEXT | nullable |  | PK |
| `value_json` | TEXT | NOT NULL |  |  |

### `agent_runs`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `task_id` | INTEGER | nullable |  | FK → `tasks.id` ON DELETE NO ACTION |
| `issue_id` | INTEGER | nullable |  | FK → `issues.id` ON DELETE NO ACTION |
| `agent_type` | TEXT | NOT NULL |  |  |
| `tokens_in` | INTEGER | nullable |  |  |
| `tokens_out` | INTEGER | nullable |  |  |
| `cache_read_tokens` | INTEGER | nullable |  |  |
| `cache_creation_tokens` | INTEGER | nullable |  |  |
| `tool_uses` | INTEGER | NOT NULL | `0` |  |
| `duration_ms` | INTEGER | NOT NULL | `0` |  |
| `started_at` | TEXT | nullable |  |  |
| `completed_at` | TEXT | nullable |  |  |
| `repo` | TEXT | nullable |  | FK → `repos.name` ON DELETE RESTRICT |
| `spawn_id` | TEXT | nullable |  |  |
| `session_id` | TEXT | nullable |  |  |
| `usage_source` | TEXT | nullable |  | CHECK `usage_source IN ('transcript','subagent_stop','unmeasured','backfill')` |
| `root_dir` | TEXT | nullable |  |  |
| `model` | TEXT | nullable |  |  |
| `host` | TEXT | nullable |  | CHECK `host IN ('claude','codex')` |
| `exit_reason` | TEXT | nullable |  | CHECK `exit_reason IN ('completed','failed','escalated','swept_orphan','swept_stale','issue_closed')` |
| `effort` | TEXT | nullable |  | CHECK `effort IN ('low','medium','high')` |
| `resumed_from` | INTEGER | nullable |  | FK → `agent_runs.id` ON DELETE NO ACTION |
| `plugin_version` | TEXT | nullable |  |  |
| `stop_cause` | TEXT | nullable |  | CHECK `stop_cause IN ('budget','hook_block')` |
| `stop_detail` | TEXT | nullable |  |  |
| `hook_block_tokens` | INTEGER | nullable |  |  |

### `session_handoffs`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `session_id` | TEXT | nullable |  | PK |
| `cwd` | TEXT | NOT NULL |  |  |
| `issue_id` | INTEGER | nullable |  | FK → `issues.id` ON DELETE NO ACTION |
| `summary` | TEXT | nullable |  |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |
| `consumed_at` | TEXT | nullable |  |  |
| `consumed_by_session` | TEXT | nullable |  |  |

### `agent_run_tool_output`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `run_id` | INTEGER | NOT NULL |  | FK → `agent_runs.id` ON DELETE CASCADE |
| `tool_name` | TEXT | NOT NULL |  |  |
| `calls` | INTEGER | NOT NULL | `0` |  |
| `result_chars` | INTEGER | NOT NULL | `0` |  |
| `est_tokens` | INTEGER | NOT NULL | `0` |  |

Table constraints:

- UNIQUE `(run_id, tool_name)`

### `pr_review_runs`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `pr_number` | INTEGER | NOT NULL |  | CHECK `pr_number > 0` |
| `repo` | TEXT | NOT NULL |  | CHECK `repo <> ''` |
| `last_fetched_at` | DATETIME | NOT NULL |  |  |
| `last_comment_id` | TEXT | nullable |  |  |
| `task_id` | INTEGER | nullable |  | FK → `tasks.id` ON DELETE NO ACTION |

Table constraints:

- UNIQUE `(pr_number, repo)`

### `prs`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `repo` | TEXT | NOT NULL |  |  |
| `number` | INTEGER | NOT NULL |  | CHECK `number > 0` |
| `state` | TEXT | NOT NULL |  | CHECK `state IN ('open','closed','merged')` |
| `created_at` | DATETIME | NOT NULL |  |  |
| `merged_at` | DATETIME | nullable |  |  |
| `updated_at` | DATETIME | NOT NULL |  |  |
| `synced_at` | DATETIME | NOT NULL |  |  |

Table constraints:

- UNIQUE `(repo, number)`

### `pr_closes`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `pr_id` | INTEGER | NOT NULL |  | FK → `prs.id` ON DELETE CASCADE |
| `issue_number` | INTEGER | NOT NULL |  | CHECK `issue_number > 0` |

Table constraints:

- PRIMARY KEY `(pr_id, issue_number)`

### `discussions_embeddings`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `discussion_id` | INTEGER | NOT NULL |  | PK; FK → `discussions.id` ON DELETE CASCADE |
| `embedding` | BLOB | NOT NULL |  |  |
| `model_id` | TEXT | NOT NULL |  |  |
| `embedded_at` | TEXT | NOT NULL |  |  |

### `audit_embeddings`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `audit_id` | INTEGER | NOT NULL |  | PK; FK → `audit.id` ON DELETE CASCADE |
| `embedding` | BLOB | NOT NULL |  |  |
| `model_id` | TEXT | NOT NULL |  |  |
| `embedded_at` | TEXT | NOT NULL |  |  |

### `cheatcodes`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `name` | TEXT | NOT NULL |  |  |
| `kind` | TEXT | NOT NULL |  | CHECK `kind IN ('skill','mcp','plugin')` |
| `origin` | TEXT | NOT NULL | `'external'` | CHECK `origin IN ('builtin','marketplace','external')` |
| `description` | TEXT | NOT NULL | `''` |  |
| `source_url` | TEXT | nullable |  |  |
| `file_path` | TEXT | nullable |  |  |
| `version` | TEXT | nullable |  |  |
| `trust_tier` | TEXT | nullable |  |  |
| `scope` | TEXT | NOT NULL | `'project-local'` | CHECK `scope IN ('global','template','project-local')` |
| `status` | TEXT | NOT NULL | `'installed'` |  |
| `installed_at` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |
| `updated_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |

Table constraints:

- UNIQUE `(name, kind)`
- CHECK `kind != 'skill' OR file_path IS NOT NULL`
- CHECK `origin = 'builtin' OR source_url IS NOT NULL`
- CHECK `origin != 'builtin' OR source_url IS NULL`

### `cheatcode_attachments`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `cheatcode_id` | INTEGER | NOT NULL |  | FK → `cheatcodes.id` ON DELETE CASCADE |
| `target` | TEXT | NOT NULL |  |  |
| `artifact` | TEXT | NOT NULL |  |  |
| `created_at` | TEXT | NOT NULL |  |  |

### `wm_directories`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK |
| `repo` | TEXT | NOT NULL |  |  |
| `path` | TEXT | NOT NULL |  |  |
| `parent_path` | TEXT | nullable |  |  |
| `summary` | TEXT | nullable |  |  |
| `summary_source` | TEXT | NOT NULL |  |  |
| `summary_updated_at` | TEXT | nullable |  |  |
| `file_count` | INTEGER | NOT NULL | `0` |  |
| `summary_sha` | TEXT | nullable |  |  |
| `commits_behind` | INTEGER | nullable |  |  |
| `dead_refs` | TEXT | nullable |  |  |
| `readme_review_pending` | INTEGER | NOT NULL | `0` |  |

Table constraints:

- UNIQUE `(repo, path)`

### `wm_files`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK |
| `repo` | TEXT | NOT NULL |  |  |
| `path` | TEXT | NOT NULL |  |  |
| `dir` | TEXT | NOT NULL |  |  |
| `purpose` | TEXT | NOT NULL | `''` |  |
| `purpose_source` | TEXT | NOT NULL | `'none'` |  |
| `content_md5` | TEXT | NOT NULL | `''` |  |
| `size_bytes` | INTEGER | NOT NULL | `0` |  |
| `last_commit_sha` | TEXT | NOT NULL | `''` |  |
| `updated_at` | TEXT | NOT NULL |  |  |
| `symbols_md5` | TEXT | nullable |  |  |
| `lane` | TEXT | NOT NULL | `'product'` | CHECK `lane IN ('test','product')` |

Table constraints:

- UNIQUE `(repo, path)`

### `wm_symbols`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK |
| `repo` | TEXT | NOT NULL |  |  |
| `path` | TEXT | NOT NULL |  |  |
| `kind` | TEXT | NOT NULL |  | CHECK `kind IN ('function','method','class','interface','type','const','sh_function','sql_table','sql_index','sql_trigger','module','hook','runner')` |
| `qualified_name` | TEXT | NOT NULL |  |  |
| `signature` | TEXT | NOT NULL | `''` |  |
| `doc` | TEXT | NOT NULL | `''` |  |
| `start_line` | INTEGER | nullable |  |  |
| `end_line` | INTEGER | nullable |  |  |
| `body_hash` | TEXT | NOT NULL |  |  |
| `exported` | INTEGER | NOT NULL | `0` |  |
| `terms` | TEXT | NOT NULL | `''` |  |
| `run_order` | INTEGER | nullable |  |  |

Table constraints:

- UNIQUE `(repo, path, kind, qualified_name)`

### `wm_edges`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `src_id` | INTEGER | NOT NULL |  | FK → `wm_symbols.id` ON DELETE CASCADE |
| `dst_id` | INTEGER | nullable |  | FK → `wm_symbols.id` ON DELETE SET NULL |
| `dst_name` | TEXT | NOT NULL |  |  |
| `kind` | TEXT | NOT NULL |  | CHECK `kind IN ('calls','imports','instantiates','sources','runs','reads_table','writes_table','indexes','triggers_on','bundles','reads_config','covers')` |
| `resolution` | TEXT | NOT NULL | `'unresolved'` | CHECK `resolution IN ('exact','name','unresolved')` |
| `line` | INTEGER | nullable |  |  |
| `hint` | TEXT | nullable |  |  |

### `wm_concepts`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK |
| `repo` | TEXT | NOT NULL |  |  |
| `kind` | TEXT | NOT NULL |  | CHECK `kind IN ('flow','subsystem','invariant')` |
| `name` | TEXT | NOT NULL |  |  |
| `body` | TEXT | NOT NULL | `''` |  |
| `status` | TEXT | NOT NULL | `'verified'` | CHECK `status IN ('verified','suspect','broken','retired')` |
| `status_reason` | TEXT | nullable |  |  |
| `verified_sha` | TEXT | nullable |  |  |
| `verified_by` | TEXT | nullable |  |  |
| `verified_at` | TEXT | nullable |  |  |
| `created_at` | TEXT | NOT NULL |  |  |
| `updated_at` | TEXT | NOT NULL |  |  |
| `steps_text` | TEXT | NOT NULL | `''` |  |

Table constraints:

- UNIQUE `(repo, name)`

### `wm_concept_steps`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `concept_id` | INTEGER | NOT NULL |  | FK → `wm_concepts.id` ON DELETE CASCADE |
| `ordinal` | INTEGER | NOT NULL |  |  |
| `repo` | TEXT | NOT NULL |  |  |
| `path` | TEXT | NOT NULL |  |  |
| `kind` | TEXT | NOT NULL | `''` |  |
| `qualified_name` | TEXT | NOT NULL | `''` |  |
| `description` | TEXT | NOT NULL |  |  |
| `handoff` | TEXT | nullable |  | CHECK `handoff IN ('calls','sources','runs','hook_fires')` |
| `hash_at_verify` | TEXT | NOT NULL |  |  |
| `trust` | TEXT | NOT NULL | `'verified'` | CHECK `trust IN ('verified','suspect','broken')` |
| `trust_reason` | TEXT | nullable |  |  |

Table constraints:

- PRIMARY KEY `(concept_id, ordinal)`

### `wm_concept_claims`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK |
| `concept_id` | INTEGER | NOT NULL |  | FK → `wm_concepts.id` ON DELETE CASCADE |
| `claim` | TEXT | NOT NULL |  | CHECK `claim IN ('exists','calls','only_writers_of','tested_by')` |
| `args` | TEXT | NOT NULL | `'{}'` |  |
| `last_result` | TEXT | nullable |  |  |

### `wm_directories_embeddings`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `dir_id` | INTEGER | NOT NULL |  | PK; FK → `wm_directories.id` ON DELETE CASCADE |
| `embedding` | BLOB | NOT NULL |  |  |
| `model_id` | TEXT | NOT NULL |  |  |
| `embedded_at` | TEXT | NOT NULL |  |  |

### `wm_files_embeddings`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `file_id` | INTEGER | NOT NULL |  | PK; FK → `wm_files.id` ON DELETE CASCADE |
| `embedding` | BLOB | NOT NULL |  |  |
| `model_id` | TEXT | NOT NULL |  |  |
| `embedded_at` | TEXT | NOT NULL |  |  |

## Foreign keys

SQLite enforces every one (`PRAGMA foreign_keys = ON`); `NO ACTION` is SQLite's default when the schema names no action, and like `RESTRICT` it refuses to delete a parent that still has children.

| From | Column(s) | → To | ON DELETE |
|---|---|---|---|
| `repo_remotes` | `repo` | `repos(name)` | CASCADE |
| `repo_env` | `repo` | `repos(name)` | CASCADE |
| `wm_freshness` | `repo` | `repos(name)` | CASCADE |
| `milestones` | `repo` | `repos(name)` | RESTRICT |
| `issues` | `repo` | `repos(name)` | RESTRICT |
| `issues` | `milestone, repo` | `milestones(name, repo)` | RESTRICT |
| `tasks` | `issue_id` | `issues(id)` | NO ACTION |
| `tasks` | `repo` | `repos(name)` | RESTRICT |
| `audit` | `issue_id` | `issues(id)` | NO ACTION |
| `audit` | `repo` | `repos(name)` | RESTRICT |
| `validation_attempts` | `task_id` | `tasks(id)` | NO ACTION |
| `validation_attempts` | `repo` | `repos(name)` | RESTRICT |
| `verification_runs` | `task_id` | `tasks(id)` | CASCADE |
| `verification_run_commands` | `run_id` | `verification_runs(id)` | CASCADE |
| `lint_runs` | `task_id` | `tasks(id)` | CASCADE |
| `lint_run_results` | `run_id` | `lint_runs(id)` | CASCADE |
| `review_findings` | `task_id` | `tasks(id)` | CASCADE |
| `roundtables` | `issue_id` | `issues(id)` | NO ACTION |
| `roundtable_votes` | `roundtable_id` | `roundtables(id)` | NO ACTION |
| `discussions` | `issue_id` | `issues(id)` | NO ACTION |
| `discussions` | `repo` | `repos(name)` | RESTRICT |
| `discussions` | `task_id` | `tasks(id)` | NO ACTION |
| `discussions` | `supersedes` | `discussions(id)` | NO ACTION |
| `agent_runs` | `task_id` | `tasks(id)` | NO ACTION |
| `agent_runs` | `issue_id` | `issues(id)` | NO ACTION |
| `agent_runs` | `repo` | `repos(name)` | RESTRICT |
| `agent_runs` | `resumed_from` | `agent_runs(id)` | NO ACTION |
| `session_handoffs` | `issue_id` | `issues(id)` | NO ACTION |
| `agent_run_tool_output` | `run_id` | `agent_runs(id)` | CASCADE |
| `pr_review_runs` | `task_id` | `tasks(id)` | NO ACTION |
| `pr_closes` | `pr_id` | `prs(id)` | CASCADE |
| `discussions_embeddings` | `discussion_id` | `discussions(id)` | CASCADE |
| `audit_embeddings` | `audit_id` | `audit(id)` | CASCADE |
| `cheatcode_attachments` | `cheatcode_id` | `cheatcodes(id)` | CASCADE |
| `wm_edges` | `src_id` | `wm_symbols(id)` | CASCADE |
| `wm_edges` | `dst_id` | `wm_symbols(id)` | SET NULL |
| `wm_concept_steps` | `concept_id` | `wm_concepts(id)` | CASCADE |
| `wm_concept_claims` | `concept_id` | `wm_concepts(id)` | CASCADE |
| `wm_directories_embeddings` | `dir_id` | `wm_directories(id)` | CASCADE |
| `wm_files_embeddings` | `file_id` | `wm_files(id)` | CASCADE |

## Search indexes

FTS5 virtual tables over a content table. SQLite creates and maintains each one's shadow tables; the triggers keep the index in step with its content table.

| FTS table | Content table | Indexed columns | Tokenizer | Shadow tables | Sync triggers |
|---|---|---|---|---|---|
| `discussions_fts` | `discussions.id` | `body` | `porter unicode61` | `discussions_fts_config`, `discussions_fts_data`, `discussions_fts_docsize`, `discussions_fts_idx` | `discussions_ai` (AFTER INSERT), `discussions_ad` (AFTER DELETE), `discussions_au` (AFTER UPDATE) |
| `audit_fts` | `audit.id` | `summary`, `content_json` | `porter unicode61` | `audit_fts_config`, `audit_fts_data`, `audit_fts_docsize`, `audit_fts_idx` | `audit_ai` (AFTER INSERT), `audit_ad` (AFTER DELETE), `audit_au` (AFTER UPDATE) |
| `wm_directories_fts` | `wm_directories.id` | `path`, `summary` | `porter unicode61` | `wm_directories_fts_config`, `wm_directories_fts_data`, `wm_directories_fts_docsize`, `wm_directories_fts_idx` | `wm_directories_ai` (AFTER INSERT), `wm_directories_ad` (AFTER DELETE), `wm_directories_au` (AFTER UPDATE), `wm_directories_embedding_stale` (AFTER UPDATE) |
| `wm_files_fts` | `wm_files.id` | `path`, `purpose` | `porter unicode61` | `wm_files_fts_config`, `wm_files_fts_data`, `wm_files_fts_docsize`, `wm_files_fts_idx` | `wm_files_ai` (AFTER INSERT), `wm_files_ad` (AFTER DELETE), `wm_files_au` (AFTER UPDATE), `wm_files_embedding_stale` (AFTER UPDATE) |
| `wm_symbols_fts` | `wm_symbols.id` | `terms`, `signature`, `doc` | `porter unicode61` | `wm_symbols_fts_config`, `wm_symbols_fts_data`, `wm_symbols_fts_docsize`, `wm_symbols_fts_idx` | `wm_symbols_ai` (AFTER INSERT), `wm_symbols_ad` (AFTER DELETE), `wm_symbols_au` (AFTER UPDATE) |
| `wm_concepts_fts` | `wm_concepts.id` | `name`, `body`, `steps_text` | `porter unicode61` | `wm_concepts_fts_config`, `wm_concepts_fts_data`, `wm_concepts_fts_docsize`, `wm_concepts_fts_idx` | `wm_concepts_ai` (AFTER INSERT), `wm_concepts_ad` (AFTER DELETE), `wm_concepts_au` (AFTER UPDATE) |

## Indexes

| Index | Table | Columns | Unique | Where |
|---|---|---|---|---|
| `idx_repo_remotes_primary` | `repo_remotes` | `repo, is_primary` |  |  |
| `idx_issues_status` | `issues` | `status` |  |  |
| `idx_issues_gh_iid` | `issues` | `gh_iid` |  |  |
| `idx_tasks_issue_branch` | `tasks` | `issue_id, branch_id` | yes |  |
| `idx_tasks_status` | `tasks` | `status` |  |  |
| `idx_tasks_commit_sha` | `tasks` | `commit_sha` |  |  |
| `idx_verification_runs_task_commit` | `verification_runs` | `task_id, commit_sha, finished_at` |  |  |
| `idx_lint_runs_task_commit` | `lint_runs` | `task_id, commit_sha, finished_at` |  |  |
| `idx_review_findings_task_status` | `review_findings` | `task_id, status` |  |  |
| `idx_discussions_issue_created` | `discussions` | `issue_id, created_at` |  |  |
| `idx_discussions_remote_comment` | `discussions` | `remote_comment_id` | yes | `remote_comment_id IS NOT NULL` |
| `idx_discussions_task` | `discussions` | `task_id` |  | `task_id IS NOT NULL` |
| `idx_discussions_supersedes` | `discussions` | `supersedes` |  | `supersedes IS NOT NULL` |
| `idx_agent_runs_task` | `agent_runs` | `task_id` |  |  |
| `idx_agent_runs_issue` | `agent_runs` | `issue_id` |  |  |
| `idx_agent_runs_open` | `agent_runs` | `agent_type` |  | `completed_at IS NULL` |
| `idx_agent_runs_spawn` | `agent_runs` | `task_id, spawn_id` | yes | `spawn_id IS NOT NULL AND resumed_from IS NULL` |
| `idx_agent_runs_resumed` | `agent_runs` | `resumed_from` | yes | `resumed_from IS NOT NULL` |
| `idx_agent_runs_session` | `agent_runs` | `session_id` |  | `session_id IS NOT NULL` |
| `idx_agent_run_tool_output_run` | `agent_run_tool_output` | `run_id` |  |  |
| `idx_audit_event_type` | `audit` | `event_type` |  |  |
| `idx_audit_issue_branch` | `audit` | `issue_id, branch_id` |  |  |
| `idx_pr_review_runs_task` | `pr_review_runs` | `task_id` |  |  |
| `idx_pr_closes_issue` | `pr_closes` | `issue_number` |  |  |
| `idx_discussions_embeddings_model` | `discussions_embeddings` | `model_id` |  |  |
| `idx_audit_embeddings_model` | `audit_embeddings` | `model_id` |  |  |
| `idx_cheatcode_attachments_cheatcode` | `cheatcode_attachments` | `cheatcode_id` |  |  |
| `idx_wm_directories_parent` | `wm_directories` | `repo, parent_path` |  |  |
| `idx_wm_files_dir` | `wm_files` | `repo, dir` |  |  |
| `idx_wm_edges_src` | `wm_edges` | `src_id` |  |  |
| `idx_wm_edges_dst` | `wm_edges` | `dst_id` |  |  |
| `idx_wm_concept_steps_anchor` | `wm_concept_steps` | `repo, path` |  |  |
| `idx_wm_concept_claims_concept` | `wm_concept_claims` | `concept_id` |  |  |
| `idx_wm_directories_embeddings_model` | `wm_directories_embeddings` | `model_id` |  |  |
| `idx_wm_files_embeddings_model` | `wm_files_embeddings` | `model_id` |  |  |
| _UNIQUE constraint_ | `repo_env` | `repo, package_path, ecosystem` | yes | |
| _UNIQUE constraint_ | `validation_attempts` | `task_id, attempt_n` | yes | |
| _UNIQUE constraint_ | `agents` | `name` | yes | |
| _UNIQUE constraint_ | `agent_run_tool_output` | `run_id, tool_name` | yes | |
| _UNIQUE constraint_ | `pr_review_runs` | `pr_number, repo` | yes | |
| _UNIQUE constraint_ | `prs` | `repo, number` | yes | |
| _UNIQUE constraint_ | `cheatcodes` | `name, kind` | yes | |
| _UNIQUE constraint_ | `wm_directories` | `repo, path` | yes | |
| _UNIQUE constraint_ | `wm_files` | `repo, path` | yes | |
| _UNIQUE constraint_ | `wm_symbols` | `repo, path, kind, qualified_name` | yes | |
| _UNIQUE constraint_ | `wm_concepts` | `repo, name` | yes | |

## Eval mode

Applied from `mcp/trajectory-server/src/schema-eval.sql` only when `TMB_EVAL_MODE=1`; production DBs do not carry these tables.

#### `debug_trajectory`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `session_id` | TEXT | NOT NULL |  |  |
| `step_n` | INTEGER | NOT NULL |  |  |
| `kind` | TEXT | NOT NULL |  |  |
| `agent` | TEXT | nullable |  |  |
| `tool_or_mcp_name` | TEXT | NOT NULL |  |  |
| `args_json` | TEXT | NOT NULL | `'{}'` |  |
| `result_json` | TEXT | NOT NULL | `'{}'` |  |
| `is_error` | INTEGER | NOT NULL | `0` |  |
| `tokens_in` | INTEGER | NOT NULL | `0` |  |
| `tokens_out` | INTEGER | NOT NULL | `0` |  |
| `latency_ms` | INTEGER | NOT NULL | `0` |  |
| `created_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |

#### `eval_results`

| Column | Type | Null | Default | Constraints |
|---|---|---|---|---|
| `id` | INTEGER | NOT NULL |  | PK AUTOINCREMENT |
| `run_id` | TEXT | NOT NULL |  |  |
| `flow_name` | TEXT | NOT NULL |  |  |
| `scorer_name` | TEXT | NOT NULL |  |  |
| `pass` | INTEGER | NOT NULL |  |  |
| `value` | TEXT | nullable |  |  |
| `explanation` | TEXT | nullable |  |  |
| `metadata_json` | TEXT | NOT NULL | `'{}'` |  |
| `arm` | TEXT | NOT NULL | `'control'` |  |
| `scenario` | TEXT | nullable |  |  |
| `created_at` | TEXT | NOT NULL | `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` |  |

#### Eval-mode indexes

| Index | Table | Columns | Unique | Where |
|---|---|---|---|---|
| `idx_debug_trajectory_session` | `debug_trajectory` | `session_id, step_n` |  |  |
| `idx_eval_results_run` | `eval_results` | `run_id, scorer_name` |  |  |
| `idx_eval_results_flow` | `eval_results` | `flow_name, created_at` |  |  |
<!-- erd:generated:end -->

## How the groups connect

- Every workflow row belongs to one issue, directly or through its task. Project-level audit and discussion rows use a schema-seeded system issue that no task may use.
- Rows that concern a repo name its `repos` row. A repo is renamed in one transaction across every table that names it, and a scan never renames one.
- Per-repo branch policy lives on the `repos` row and nowhere else ([Multi-repo workspaces](./GIT.md#multi-repo-workspaces)); `plugin_config` holds only workspace-global settings ([`CONFIG_KEYS.md`](../reference/CONFIG_KEYS.md)).
- A few references are soft: a task's branch name is unique only within its issue, so rows that point at a branch carry no declared foreign key.

## Rules the data keeps

- **One timestamp format.** Every timestamp is UTC ISO 8601 with milliseconds, so ordering and keyset cursors compare them as plain strings.
- **Nothing closes silently.** An issue never closes over live work, and a task never reaches `closed` without the record saying whether it was reviewed: a close with no passing review writes an explicit bypass or waiver row. A review passes a commit only when it was recorded at or after that commit's review anchor (bro's verification of it, or an integrate that carried the review across a trivial rebase); one shared rule in `mcp/trajectory-server/src/review-sql.ts` decides it for every reader.
- **Verdicts are append-only.** A re-recorded review attempt adds a row instead of replacing one; a finding's status moves from open to fixed or waived, and the finding stays.
- **Verification is recorded, not re-run.** Each run of a task's checks, and each run of its close lints, is a row with its commands or lints, so bro, code-reviewer and the reviewer preflight read the result for an exact commit.
- **Cost is metered, not stored as totals.** Agent runs carry measured token counts; task cost and rework are computed from them at read time.
- **Audit is event-only.** Each audit row is one lifecycle event; tool-call capture lives in the eval-mode tables.
- **Roles are enforced by the server, not the schema.** Which agent may write which table follows each tool's role check ([`RESPONSIBILITIES.md`](./RESPONSIBILITIES.md)).

## Data contracts

The schema says what a row may hold; data contracts say what the rows TMB writes over time must look like. One declarative list, `mcp/trajectory-server/src/data-contracts.ts`, drives the `trajectory_doctor` tool, the session-start health line and the end-to-end test gate. That list is the contract catalog.

## Schema migration policy

`schema.sql` is applied idempotently on every open. Forward migrations run automatically on open, one step per schema version, after a snapshot of the DB file; a DB newer than the code is refused, never downgraded. `mcp/trajectory-server/src/db.ts` holds the steps.
