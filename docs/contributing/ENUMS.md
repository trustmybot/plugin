# DB ENUM Doctrine

**Source of truth for every controlled vocabulary in the trajectory DB.** Same governance rule as [`LABELS.md`](./LABELS.md): adopt established conventions where they exist; invent only when no industry analog applies.

## Why this matters

Hooks branch on these values. Skills assert on them. Bro chooses paths based on them. A typo or a silent rename breaks downstream code without a compile error. A canonical doc + a lint guard catches drift before it ships.

---

## Canonical ENUM tables

### `issues.status` — issue lifecycle

| Value | Source | Meaning |
|---|---|---|
| `open` | GitHub | Newly created, not yet closed |
| `closed` | GitHub | Resolved (fixed, wontfix, duplicate, etc.) |

We deliberately match GH's two-state model. K8s pod phases (`Pending/Running/Succeeded/Failed/Unknown`) don't fit issues — issues are tasks, not processes. Schema enforces via `CHECK (status IN ('open','closed'))` (v29).

### `tasks.status` — task lifecycle

| Value | Source | Meaning |
|---|---|---|
| `pending` | TMB | Task spec exists; SWE has not started |
| `running` | K8s pod phase | SWE is actively executing |
| `needs_validation` | TMB | Work state awaiting verification before close |
| `completed` | K8s pod phase | SWE returned with commit_sha; awaiting bro task-gate (progress counters show it as awaiting close, not done) |
| `closed` | TMB | Bro task-gate verified, task is done (the only status progress counters count as done) |
| `failed` | K8s pod phase | SWE returned with error; awaiting bro decision |
| `escalated` | TMB | Bro escalated to Human after max retries |

Hybrid: K8s pod phases for the SWE-execution states (`running`/`completed`/`failed`), TMB-specific for the workflow gates (`pending`/`needs_validation`/`closed`/`escalated`). Schema enforces via `CHECK (status IN (...))` over exactly these seven values (v29).

### `validation_attempts.verdict` — pr-reviewer verdict at push gate

| Value | Source | Meaning |
|---|---|---|
| `pass` | TMB | Commits OK to push |
| `fail` | TMB | Issues found; SWE re-spawn or Human override needed |
| `escalate` | TMB | Outside pr-reviewer's authority; Human decides |

We considered aligning to GH PR review states (`approved`/`changes_requested`/`commented`/`dismissed`), but `pass`/`fail`/`escalate` reads cleaner for our 2-gate model. **TMB-specific by deliberate choice** — documented here, lint-guarded. Schema enforces via `CHECK (verdict IN ('pass','fail','escalate'))` (v29).

### `roundtables.state` — roundtable state machine

| Value | Source | Meaning |
|---|---|---|
| `collecting` | TMB | Votes being gathered from participants |
| `awaiting_human` | TMB | All expected votes received; pending Human ratification |
| `closed` | TMB | Human ratified; decisions finalized |
| `skipped` | TMB | Roundtable cancelled or consensus reached without full vote |

Server enforces valid transitions: `collecting → awaiting_human → closed | skipped`. Other transitions return `is_error: true`.

### `issues.remote_kind` — git remote host for issue sync

| Value | Source | Meaning |
|---|---|---|
| `github` | TMB | GitHub (github.com or GHE) |
| `gitlab` | TMB | GitLab (gitlab.com or self-hosted) |

Mirrors `repo_remotes.provider` (see [`repo_remotes.provider`](#repo_remotesprovider---git-host-provider-per-remote)). Only these two values are supported for issue sync. Schema enforces via `CHECK(remote_kind IN ('github','gitlab'))`.

### `discussions.kind` — narrative kind in issue discussions

| Value | Source | Meaning |
|---|---|---|
| `intent` | TMB | The Human's original ask, captured verbatim |
| `note` | TMB | Bro's running narrative (planning, triage, status), and each PR/MR comment `pr_monitor_comments_get` persists |
| `question` | TMB | Open question raised by an agent or the Human |
| `answer` | TMB | Resolution to a `question` |
| `analysis` | TMB | Consultant's structured analysis on a topic |
| `decision` | TMB | Bro's architectural decision record (narrative form) |

K8s Events have a `reason` field with a similar shape but different semantics. **TMB-specific** — these mirror our agent communication patterns. Schema enforces via `CHECK (kind IN ('intent','question','answer','decision','note','analysis'))` (v29).

### `milestones.state` — milestone lifecycle

| Value | Source | Meaning |
|---|---|---|
| `open` | GitHub | Milestone accepting issues |
| `closed` | GitHub | Milestone shipped or wound down |

Schema enforces via `CHECK (state IN ('open','closed'))` (v29). `scan_run` imports the remote's state (GitLab `active` → `open`); `milestone_close` sets `closed`.

### `milestone_default` — why `issue_create` / `intent_start` bound a milestone

Returned in the created-issue payload, not stored.

| Value | Meaning |
|---|---|
| `applied` | No milestone passed; the repo's sole open milestone was applied |
| `explicit` | The caller passed a milestone |
| `none_open` | No milestone passed and the repo has no open milestone (or no repo resolved); the issue stays untriaged |
| `multiple_open` | No milestone passed and the repo has several open milestones; the issue stays untriaged and the payload lists them in `open_milestones` |

### `audit.from_node` — which agent or persona logged the event

| Value | Source | Notes |
|---|---|---|
| `bro` | TMB persona | The single Human entry point |
| `swe` | TMB agent | Executor (one task per spawn) |
| `pr-reviewer` | TMB agent | Push-gate reviewer |
| `architect` | TMB consultant template | Project consultant |
| `cto` | TMB consultant template | Project consultant |
| `ceo` | TMB consultant template | Project consultant |
| `pm` | TMB consultant template | Project consultant |
| `<custom>` | per-project | User-created agents (e.g. `legal-reviewer`, `security-reviewer`) |
| `system` | TMB runtime | A machine event with no agent or hook author |
| `executor` | TMB server | Issue-sync bookkeeping the server writes on its own (`issue_adopted`, `issue_linked`, `sync_skipped`) |
| `trajectory-server` | TMB server | `tmb_branch_autocreated` rows written when `task_create_batch` creates a branch ref |
| `hook:<name>` | TMB hook / script | A row written by a hook or script, `<name>` = its basename without `.sh` (e.g. `hook:swe-brief-gate`, `hook:scan`); matches `hook:[a-z0-9-]+` |

**TMB-specific** — these are TMB's role names. Custom agents added to a project become valid `from_node` values for that project's DB only. A hook never writes an agent role: every audit row a hook writes goes through the write library (`tmb_audit_append` in `scripts/hooks/lib/db-write.sh`) as `hook:<name>`.

### `audit.event_type` — workflow events

The closed set lives in `mcp/trajectory-server/src/audit-events.ts`; this table is generated from it by `scripts/maintenance/gen-enums-doc.mjs` (edit the TS source, run `npm run build` in `mcp/trajectory-server/`, then `node scripts/maintenance/gen-enums-doc.mjs`). `insertAudit` and the bro-facing `audit_append` reject any other value with the allowed list; hooks validate against `scripts/hooks/lib/audit-events.txt` (`event<TAB>writers` lines), which `npm run build` generates from the same source. **Writers** names who may author the event: an agent role (the role of the role-gated tool that writes it, or the agent that records it through `audit_append`), `server` (a server path no role gates, such as a migration), or `hook` (a hook or script through `tmb_audit_append`). `audit_append` refuses a caller whose role is not listed with `audit_event_not_writable_by_role` and records `from_node` as the caller; `tmb_audit_append` refuses a hook write of an event that does not list `hook`. A `reserved` row is written by an agent through `audit_append` rather than by a code literal.

<!-- BEGIN GENERATED audit.event_type: scripts/maintenance/gen-enums-doc.mjs -->
| Value | Writers | Trigger |
|---|---|---|
| `agent_arg_mismatch` | `hook` | `agent-arg-matches-caller` denied a trajectory-server call whose `agent` argument named another role than the caller (the payload's `agent_type`, or bro for the main session); one row per denial on the task's issue when `tool_input` carries a `task_id`, else the system issue `-1`, from_node `hook:agent-arg-matches-caller`; `content_json` carries `tool`, `given`, `actual`, `task_id`. `audit_append` refuses this event |
| `agent_runs_capture_skipped` | `hook` | `swe-atomic-close` could not bind a SWE spawn to a task (no `task_id=<N>` in the spawn transcript, or no such task) and wrote no `agent_runs` row; filed under the system issue `-1`; `content_json` carries `reason`, `transcript`, `spawn_id`, `task_id` |
| `agent_runs_backfilled` | `bro` | `agent_runs_backfill` (dry_run false) recovered `agent_runs` rows from archived Claude Code transcripts; one row per run on the system issue `-1`, from_node `bro`; `content_json` is the report: `transcripts_dir`, `transcripts_seen`, `sessions_seen`, `bound`, `unbound` (`count`, `first` — up to 20 `{path, reason}`), `rows_inserted`, `rows_updated`, `rows_skipped_measured`, `tokens_total_added` |
| `agent_runs_claimed` | `hook` | `bro-turn-usage` claimed bro `agent_runs` rows opened without a `session_id` for its session (one row per claim, on the rows' issue when they share one, else the system issue `-1`); `content_json` carries `run_ids`, `session_id` |
| `branch_gate_waived` | `bro` | `task_create_batch` ran with `waive_branch_gate`; `content_json` carries the waiver reason |
| `branch_id_proposed` | `bro` | `intent_start` proposed the issue's feature branch; `content_json` carries `branch_id`, `objective`; the scope and branch gates read it |
| `bro_verification_fail` | `bro` | Bro task-gate found a V1/V2/V3 check that failed |
| `bro_verification_pass` | `bro` | Bro task-gate V1/V2/V3 all passed; `content_json` carries `task_id`, `commit_sha`, and from `bro_atomic_close` a `scope` record (`extras_accepted`, `base_moved`, `recorded_base`, `merge_base`) that `task_brief` reads |
| `cheatcode_activate` | `bro` | `cheatcode_activate` confirmed or failed a cheatcode's load; `content_json` carries the resulting status |
| `cheatcode_approved` | `bro` | `cheatcode_approve` recorded the Human's install approval; the `cheatcode-install-approval` hook reads it |
| `cheatcode_healthcheck` | `hook` | `cheatcode-healthcheck` moved a cheatcode's status (e.g. `active` → `broken`); filed under the system issue `-1` |
| `cheatcode_install` | `bro` | `cheatcode_install` ran the install script; `content_json` carries `method` and the script outcome |
| `cheatcode_installed` | `bro` | `cheatcode_install` registered the installed cheatcode row; `content_json` carries `cheatcode_id` |
| `cheatcode_search` | `bro` | `cheatcode_search` finished; `content_json` carries `query`, `kind`, `candidate_count`, and `top` ranked candidates |
| `cheatcode_uninstalled` | `bro` | `cheatcode_uninstall` removed a cheatcode |
| `cheatcode_vet` | `bro` | `cheatcode_vet` classified a candidate; `content_json` carries `trust_tier` and the vet signals |
| `config_changed` | `bro` | reserved — An agent changed a `plugin_config` key through `/onboard`; written by bro via `audit_append` |
| `consultant_spawn_nudged` | `hook` | `prompt-intent-hints` emitted the consultant-spawn nudge; filed under the system issue `-1` |
| `containment_denied` | `hook` | `containment-guard` denied a write outside the run's root (on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `root`, `task_id` |
| `decision_gate_waived` | `bro` | `task_create_batch` ran with `waive_decision_gate`; `content_json` carries the waiver reason |
| `deep_scan_completed` | `bro` | `scan_run` finished; `content_json` carries `source`, `structural_change`, `repos_seen`, `top_dirs` |
| `embeddings_degraded` | `server` | The embedding model entered the degraded state — it could not load, or `TMB_EMBED_FAIL_THRESHOLD` (default 5) consecutive embed calls failed — so semantic search falls back to FTS until a timed re-attempt (1 min, 5 min, then every 10 min) succeeds; one row per degraded episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `reason`, `consecutive_failures` |
| `embeddings_recovered` | `server` | A re-attempt brought the degraded embedding model back; one row per episode on the system issue `-1`, from_node `trajectory-server`; `content_json` carries `degraded_since`, `reason`, `retries` |
| `intent_gate_waived` | `bro` | `task_create_batch` ran with `waive_intent_gate`; `content_json` carries the waiver reason |
| `issue_adopted` | `bro` | `issue_create` or `issue_adopt_remote` adopted an existing remote issue as the local issue's twin; `content_json` carries `issue_id`, `backend`, `remote_iid` |
| `issue_auto_close_deferred` | `hook` | `close-issue-on-merge` left an issue named by a merged PR's closing-ref open because other tasks of it are still live; `content_json` carries `blocking_task_ids`, `gh_iid` |
| `issue_auto_close_remote_skipped` | `hook` | `close-issue-on-merge` closed an issue locally but not its GitHub twin because issue sync is off (`plugin_config.issue_sync` unset or `off`, or `TMB_DISABLE_REMOTE_SYNC` set); `content_json` carries `gh_iid`, `reason` |
| `issue_auto_closed_on_merge` | `hook` | `close-issue-on-merge` closed a local issue named by a merged PR's closing-ref; `content_json` carries `gh_iid` |
| `issue_close_remote_skipped` | `server` | `issue_close`, `bro_atomic_close` or `task_recover` closed an issue locally but no linked remote because the remote-sync gate is off: `reason` is `issue_sync_off` (`plugin_config.issue_sync` unset or `off`), `env_disabled` (`TMB_DISABLE_REMOTE_SYNC` set) or `no_backend` (no usable gh/glab for the issue repo's remotes); `content_json` carries `reason`, `remotes` |
| `issue_linked` | `bro` | `issue_link` bound a local issue to a remote issue; `content_json` carries `issue_id`, `backend`, `iid`, `forced` |
| `mcp_unavailable_fallback_invoked` | `bro`, `swe`, `pr-reviewer`, `consultant` | The sqlite3 fallback (`scripts/lib/sqlite3-fallback.sh`) wrote in place of an unavailable MCP server; filed under the system issue `-1` |
| `milestone_closed` | `bro` | `milestone_close` closed a milestone; `content_json` carries `name`, `repo`, `forced`, `open_issues`, `remote_closed` |
| `milestone_reconcile_failed` | `bro` | `scan_run` could not read a repo's remote milestones; `content_json` carries `repo`, `backend`, `reason` (the scan still succeeds) |
| `milestone_seed_skipped` | `bro` | `scan_run` found no milestones and could not seed one; `content_json` carries `repo`, `reason` (`no_version_source` or `reconcile_failed`) |
| `milestone_seeded` | `bro` | `scan_run` seeded `v<next-patch>` for a repo with no milestones; `content_json` carries `name`, `repo`, `source`, `remote_created` |
| `milestones_reconciled` | `bro` | `scan_run` imported a repo's remote milestones; `content_json` carries `imported`, `closed`, `repo` |
| `planning_complete` | `bro` | Bro finished planning: batched `task_create_batch` + SWE spawn |
| `readme_staleness_surfaced` | `hook` | `post-atomic-close-readme` surfaced READMEs a closed task may have left stale |
| `registry_gate_waived` | `bro` | `task_create_batch` ran with `waive_registry_gate`; `content_json` carries the waiver reason |
| `repo_remotes_migration_skipped` | `server` | The v35 migration could not move a repo's `repos.remotes` JSON into `repo_remotes` — the value did not parse as an array or a name → url map, or some entries carried no url or a duplicate name (the rest moved); one row per repo on the system issue `-1`, written by `system`; `content_json` carries `repo`, `reason`, `raw` |
| `repo_rename_detected` | `bro` | `scan_run` found a discovered repo whose canonical path or primary remote URL matches an existing row under another name; no second row is inserted and the old row is kept until `repo_rename`; filed under the system issue `-1` by `bro`; `content_json` carries `old`, `new`, `by` (`path` or `remote`) |
| `repo_renamed` | `bro` | `repo_rename` moved a repo to a new name: the `repos` row, its FK children, `pr_review_runs` host slugs and the world-model nodes; filed under the system issue `-1` by `bro` with `repo` = the new name; `content_json` carries `old`, `new`, `reason`, `rows_by_table`, `graph` (`rekeyed`, or `deferred` when kuzu was unavailable or failed — the next `scan_run` rebuilds), `graph_nodes`, and `graph_error` when the re-key failed |
| `review_gate_bypassed` | `bro`, `hook` | A task reached `closed` by a path other than `bro_atomic_close` (`close-issue-on-merge`, `task_recover`, `task_update_status`) with no passing pr-reviewer verdict for its current commit; the task still closes. At most one row per task and commit (none when a `review_gate_waived` row already names them); `content_json` carries `task_id`, `commit_sha`, `closed_by`. A verdict counts as passing when `verdict = 'pass'` and its `created_at` is at or after the earliest `bro_verification_pass` row naming the task and its current `commit_sha` |
| `review_gate_waived` | `bro` | `issue_close(waive_review: true)` closed an issue over a closed task with no passing pr-reviewer verdict for its current commit; one row per such task; `content_json` carries `skill`, `task_id`, `commit_sha`, `waive_review_reason` |
| `reviewer_identity_observed` | `hook` | `reviewer-identity-observe` saw a pr-reviewer subagent call `validation_record` (the payload carried `agent_id` and an `agent_type` that normalises to `pr-reviewer`); one row per call on the task's issue, from_node `hook:reviewer-identity-observe`; `content_json` carries `task_id`, `attempt_n`, `session_id`, `agent_id`, `consumed` (0 until `validation_record` stamps `subagent_session_id` and `reviewer_agent_id` from it and sets 1). `audit_append` refuses this event |
| `roundtable_slash_invoked` | `hook` | `roundtable-slash-detect` saw the Human type `/roundtable`; `roundtable_create` consumes the row |
| `roundtable_summary` | `bro` | reserved — Bro recorded a roundtable's outcome summary via `audit_append`; `roundtable-cleanup-postcheck` requires it |
| `scan_discovered` | `server`, `hook` | A scan registered a newly discovered cheatcode (`scan_run`, or `scan.sh` as `hook:scan`); filed under the system issue `-1`; `content_json` carries `name`, `kind`, `origin`, `source` |
| `scan_discovered_repair` | `server` | The v32 migration deleted `scan_discovered` rows whose `(name, kind)` has no `cheatcodes` row; filed under the system issue `-1` by `system`; `content_json` carries `deleted` |
| `scope_gate_waived` | `bro` | `bro_atomic_close(waive_scope_gate: true)` accepted the task's changed paths outside its `files[]` with a `scope_waiver_reason`; `content_json` carries `skill`, `task_id`, `commit_sha`, `accepted_paths`, `reason`, `base_moved`, `recorded_base`, `merge_base`. `task_create_batch(waive_scope_gate: true)` writes one when it skips its question gate, `content_json` carrying `waive_scope_gate_reason`, `tasks_created` |
| `skill_creator_blocked` | `bro` | reserved — `tmb_skill-creator` halted before writing the skill (no Human approval); written by bro via `audit_append` |
| `spec_shape_gate_waived` | `bro` | `task_create_batch` ran with `waive_spec_shape`; `require-task-spec` reads a bro-written row as the spawn waiver; `content_json` carries the waiver reason |
| `swe_brief_fetched` | `hook` | `swe-brief-gate` recorded that a SWE fetched its `task_brief`; the brief gate and `bro-turn-usage` read it |
| `sync_skipped` | `bro` | Issue sync skipped a remote write because `issue_sync` is off; `content_json` carries `issue_id`, `reason` |
| `task_escalated_by_issue_close` | `bro` | `issue_close(cascade: true)` escalated a live task (`pending`/`running`/`needs_validation`/`completed`) of the issue it closed and closed its open `agent_runs` rows as `issue_closed`; one row per task; `content_json` carries `task_id`, `from_status`, `reason` |
| `task_escalated_repair` | `server` | The v33 migration escalated a task still `pending`/`running`/`needs_validation`/`completed` whose issue was already `closed` and closed its open `agent_runs` rows as `issue_closed`; written by `system`; `content_json` carries `task_id`, `issue_id`, `from_status` |
| `task_recovered` | `bro` | `task_recover` closed a task stuck in `running`/`completed` at its commit; `content_json` carries `task_id`, `commit_sha`, `prior_status` |
| `task_reopened` | `bro` | `task_reopen` moved a `closed` / `failed` / `escalated` / `running` task back to `running` for rework; `content_json` carries `task_id`, `from_status`, `reason`, `files_add`, `verification_add` |
| `task_retry_attempted` | `bro` | `task_retry` created a retry task for a failed one; `content_json` carries `failed_task_id`, `new_task_id`, `new_branch_id` |
| `task_spec_amended` | `bro` | `task_update_spec` replaced a live task's `files` / `verification` / `spec_body`; `content_json` carries `task_id`, `status`, `reason`, `changes` |
| `task_stale_swept` | `bro` | `task_recover` moved a `running` task with no open swe `agent_runs` row and no update for `TMB_STALE_RUNNING_HOURS` (default 6) to `failed` and closed its open runs as `swept_stale`; `content_json` carries `task_id`, `from_status`, `last_updated_at`, `stale_after_hours` |
| `tmb_agent_created` | `server`, `bro` | `agent_register` registered a project-local consultant; `content_json` carries `name`, `mode`, `agent_id` |
| `tmb_branch_autocreated` | `bro` | `task_create_batch` created the task's feature branch ref |
| `tmb_skill_created` | `bro` | reserved — `tmb_skill-creator` landed a new skill; written by bro via `audit_append` |
| `trajectory_doctor_run` | `bro` | `trajectory_doctor(record: true)` checked the trajectory DB against its data contracts (`mcp/trajectory-server/src/data-contracts.ts`); filed under the system issue `-1` by `bro`; `content_json` is the report: `healthy`, `checked_at`, `schema` (`stored`, `required`, `current`), `violations` (`id`, `severity`, `description`, `actual`, `expected`, `sample`), `skipped` (`id`, `reason`), `embeddings` (the server's `embeddingStatus()`: `state`, `since`, `reason`, `consecutive_failures`, `next_retry_at`) |
| `validation_session_unverified` | `server` | `validation_record` recorded an honor-system verdict (`mcp_available: false`) with no `reviewer_identity_observed` row, so `subagent_session_id` is the caller's unverified value and `reviewer_agent_id` is NULL; on the task's issue, from_node `trajectory-server`; `content_json` carries `task_id`, `attempt_n`, `subagent_session_id` |
| `verification_gate_waived` | `hook` | `swe-verification-gate` honoured a SWE's `waive_verification_gate_reason`; at most one row per task and commit; `content_json` carries `task_id`, `commit_sha`, `waiver_reason` |
<!-- END GENERATED audit.event_type -->

**TMB-specific** — these are TMB workflow events. A new event type is added to `audit-events.ts`; the server, the hooks and this table follow from it. DBs created before schema v32 may still hold `event_type` and `from_node` values outside these sets, written by older hooks; they are not repaired.

### `cheatcodes.kind` — capability kind in the unified registry

| Value | Meaning |
|---|---|
| `skill` | A SKILL.md capability (builtin `tmb_*` or installed) |
| `mcp` | An MCP server toolkit |
| `plugin` | A full plugin |

Schema enforces via `CHECK(kind IN ('skill','mcp','plugin'))`. The `cheatcodes` table is the single typed registry for every capability the project knows about.

### `cheatcodes.origin` — provenance of the capability

| Value | Meaning |
|---|---|
| `builtin` | Plugin-shipped `tmb_*` capability; `source_url` is NULL |
| `marketplace` | Acquired from a registered Claude Code marketplace; `source_url` is the `<name>@<marketplace>` ref or a marketplace-relative path |
| `external` | Acquired from a raw external repo URL (registered as a marketplace first); `source_url` carries the candidate identity. The column default for an acquired row |

Provenance, not lifecycle — the install lifecycle is `status`. Schema enforces via `CHECK(origin IN ('builtin','marketplace','external'))`, plus paired `CHECK`s: `marketplace` and `external` rows require `source_url`, `builtin` rows forbid it.

### `cheatcodes.scope` — where the capability lives

| Value | Meaning |
|---|---|
| `global` | Plugin-shipped / user-wide |
| `template` | `templates/` copied per-project on demand |
| `project-local` | `<project>/.claude/` authored locally |

Schema enforces via `CHECK(scope IN ('global','template','project-local'))`.

### `agents.file_path` root marker — where an agent's prompt file ships from

| Value | Meaning |
|---|---|
| `plugin:` | Relative to the installed plugin root (`plugin:agents/swe.md`, `plugin:templates/agents/cto.md`) |
| `project:` | Relative to the workspace root (`project:.claude/agents/<name>.md`) |

Schema enforces via `CHECK(file_path LIKE 'plugin:%' OR file_path LIKE 'project:%')` (schema v34). The backbone agents `swe` and `pr-reviewer` are always `plugin:`. `agent_list` filters by `root` (`plugin`/`project`) and returns each row's absolute `resolved_path`.

### `cheatcodes.status` — lifecycle

Two lifecycles share the column. Acquired cheatcodes (`marketplace` / `external`):

| Value | Meaning |
|---|---|
| `installed` | Recorded but not confirmed loaded (new installs land here) |
| `active` | Loaded / usable (builtin skills seed here; `cheatcode_activate` advances a loaded skill here) |
| `broken` | Recorded but failed (e.g. an uninstall whose teardown left the artifact on disk) |

Builtin skills registered with `skill_register` start at `draft` and move one step at a time through `skill_promote` (`tools/skills.ts`):

| Value | Meaning |
|---|---|
| `draft` | Registered, not yet reviewed (the `skill_register` default) |
| `pending_review` | Submitted for review (`draft` →) |
| `active` | Reviewed and in use (`pending_review` →) |
| `deprecated` | Kept on record but out of use (`active` →) |

No `CHECK` constraint — runtime reconciliation to `active`/`broken` is the health-check's job, and `skill_promote` rejects any other transition. `trust_tier` is free-form text carrying the vet classification for installed rows and the curation tier (`curated`) for builtin ones.

### `plugin_meta.schema_version` — DB schema version (integer)

Currently `34`. Bumped on any breaking schema change. **NOT free-form** — every increment requires a migration step in `db.ts:runMigrations`.

### `agent_runs.usage_source` — where a run's token values came from

| Value | Meaning |
|---|---|
| `transcript` | Measured by the bro Stop hook from the session transcript (bro rows) |
| `subagent_stop` | Measured by the SubagentStop hook from the spawn's transcript (swe rows) |
| `unmeasured` | The run closed without a measurement; the four token columns are NULL |
| `backfill` | Recreated after the fact from an archived transcript by `agent_runs_backfill` / `scripts/maintenance/backfill-agent-runs.sh` (not a live hook); never written over a `transcript` / `subagent_stop` row |

`CHECK`-enforced. NULL until the run is first measured.

**Time-window rule.** A bro row's tokens are the sum of its session transcript's usage over the main-loop assistant messages with `started_at − 2 s ≤ timestamp < COALESCE(completed_at, now)` (the 2 s absorbs clock skew; where windows overlap, the row with the newest `started_at` owns the message). The Stop hook recomputes these sums absolutely on every Stop for each row of its session that is open or closed within the last 24 h. A swe row carries the totals of its spawn's whole transcript.

**Computed total.** The total token count is not a column: `task_stats` reports `tokens_total = tokens_in + tokens_out + cache_read_tokens + cache_creation_tokens` (NULL counts as 0; a never-measured spawn reports NULL).

### `agent_runs.host` — the agent host that ran the run

| Value | Meaning |
|---|---|
| `claude` | Claude Code (every row written before v33 is backfilled to `claude`) |
| `codex` | OpenAI Codex |

`CHECK`-enforced; stamped when the row opens.

### `agent_runs.exit_reason` — how a run ended

| Value | Set by |
|---|---|
| `completed` | `bro_atomic_close`; `close-issue-on-merge` closing a merged task; a SubagentStop whose task is completed/closed |
| `failed` | `task_update_status` → `failed`; a SubagentStop whose task is still pending/running |
| `escalated` | `task_update_status` → `escalated` |
| `swept_orphan` | `task_recover` sweeping a never-measured row; `task_brief` closing an earlier spawn's open swe row (older than 10 min); v33 backfill of an `unmeasured` row |
| `swept_stale` | `task_recover` sweeping a measured row left open on a terminal task, or the open runs of a stale `running` task it swept to `failed` |
| `issue_closed` | The row's issue was closed under it (the v33 GH 1212 repair; `issue_close(cascade: true)`) |

`CHECK`-enforced; NULL while the row is open (and on pre-v33 rows whose end is not derivable).

### Timestamp format

Every timestamp column (`*_at`) holds `YYYY-MM-DDTHH:MM:SS.sssZ` — 24-char UTC ms-ISO, the shape of `new Date().toISOString()` and `strftime('%Y-%m-%dT%H:%M:%fZ','now')`.

### `agent_runs.agent_type` (open enum)

Common values: `bro`, `swe`, `pr-reviewer`, `architect`, `cto`, `pm`, `ceo`. Open enum — accept any string. Document the canonical values for query convenience.

### `repo_remotes.provider` — git host provider per remote

| Value | Meaning |
|---|---|
| `github` | github.com or GitHub Enterprise |
| `gitlab` | gitlab.com or self-hosted GitLab |
| `other` | Any other host (Bitbucket, Codeberg, Azure DevOps, custom) |

Schema enforces via `CHECK (provider IN ('github','gitlab','other'))`. The writer (`upsertRepoRemotes`, and the v35 migration from the v34 `repos.remotes` JSON) derives the value from the URL host:

- `github.com` → `github`
- `gitlab.com` or `gitlab.<corp>.<tld>` → `gitlab`
- everything else → `other`, except that a blank or unrecognised URL keeps a declared `github`/`gitlab` (onboard records the chosen provider before the repo has a URL)

`onboard_state_get`'s `probe.detected_remotes[].provider` still reports the finer host classification (`bitbucket`, `codeberg`, `azuredev`) — it is a probe result, not a stored value.

### `verification_runs.source` — who ran the verification

| Value | Meaning |
|---|---|
| `gate` | `swe-verification-gate.sh` ran `verification[]` on the swe close |
| `manual` | reserved for a run recorded outside the gate; no writer yet |

Schema enforces via `CHECK (source IN ('gate','manual'))`.

### `verification_runs.timed_out`

`1` when the run's budget ran out (its `exit_code` is then `124`, as is the command row of the command that was running); `0` otherwise. `CHECK (timed_out IN (0,1))`.

### `repo_remotes.is_primary`

`1` on the remote named `origin`, else on the first remote recorded; `0` on the rest. `CHECK (is_primary IN (0,1))`.

---

## How to add a new ENUM value

1. Open a PR that adds the value to this doc AND to the schema/code that consumes it.
2. Add a test that covers the new value's path.
3. For `audit.event_type`, add the value to `mcp/trajectory-server/src/audit-events.ts` instead of this doc; the table above is regenerated from it.

---

## Lint guard

`tests/l1-lint/enums-stable.sh` compares code and this doc both ways for `audit.event_type`, `audit.from_node`, `tasks.status`, `issues.status`, `validation_attempts.verdict`, `discussions.kind`, `milestones.state` and `agent_runs.usage_source`: every value found in `mcp/trajectory-server/src/` (the `schema.sql` `CHECK` lists of the six `CHECK`-backed columns, and the literals written or compared; `src/test/` is not scanned) and `scripts/` (including the event types passed to `tmb_audit_append` / `tmb_audit_sql`) must be documented here, and every documented value must appear in code unless its row is marked `reserved`. `tests/l1-lint/enums-doc-fresh.sh` fails when the generated `audit.event_type` table or `scripts/hooks/lib/audit-events.txt` differs from `audit-events.ts`.

---

## Related

- [`LABELS.md`](./LABELS.md) — same governance rule for GH issue labels and `issue_labels` DB table (when shipped, see #38)
- `mcp/trajectory-server/src/schema.sql` — schema source of truth
- [`CONFIG_KEYS.md`](../reference/CONFIG_KEYS.md) — `plugin_config` key registry (different doc because keys are looser than ENUMs)
