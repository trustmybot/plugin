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

Mirrors `repos.remotes[].provider` (see [`repos.remotes[].provider`](#reposremotesprovider---git-host-provider-per-remote)). Only these two values are supported for issue sync. Schema enforces via `CHECK(remote_kind IN ('github','gitlab'))`.

### `discussions.kind` — narrative kind in issue discussions

| Value | Source | Meaning |
|---|---|---|
| `intent` | TMB | The Human's original ask, captured verbatim |
| `note` | TMB | Bro's running narrative (planning, triage, status) |
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
| `hook:<name>` | TMB hook / script | A row written by a hook or script, `<name>` = its basename without `.sh` (e.g. `hook:swe-brief-gate`, `hook:scan`); matches `hook:[a-z0-9-]+` |

**TMB-specific** — these are TMB's role names. Custom agents added to a project become valid `from_node` values for that project's DB only. A hook never writes an agent role: every audit row a hook writes goes through the write library (`tmb_audit_append` in `scripts/hooks/lib/db-write.sh`) as `hook:<name>`.

### `audit.event_type` — workflow events

| Value | Trigger |
|---|---|
| `planning_complete` | Bro finishes planning, batched task_create + SWE spawn |
| `scope_gate_waived` | Bro waives the scope gate with explicit reason |
| `bro_verification_pass` | Bro task-gate V1/V2/V3 all passed |
| `bro_verification_fail` | Bro task-gate found a check that failed |
| `deep_scan_completed` | `scan_run` finished; `content_json` carries `source`, `structural_change`, `repos_seen`, `top_dirs` |
| `swe_retry_spawned` | Bro spawned a SWE retry after failure; captures retry rationale in `content_json` |
| `cheatcode_search` | `cheatcode_search` finished; `content_json` carries `query`, `kind`, `candidate_count`, and `top` ranked candidates |
| `milestones_reconciled` | `scan_run` imported a repo's remote milestones; `content_json` carries `imported`, `closed`, `repo` |
| `milestone_reconcile_failed` | `scan_run` could not read a repo's remote milestones; `content_json` carries `repo`, `backend`, `reason` (the scan still succeeds) |
| `milestone_seeded` | `scan_run` seeded `v<next-patch>` for a repo with no milestones; `content_json` carries `name`, `repo`, `source`, `remote_created` |
| `milestone_seed_skipped` | `scan_run` found no milestones and could not seed one; `content_json` carries `repo`, `reason` (`no_version_source` or `reconcile_failed`) |
| `milestone_closed` | `milestone_close` closed a milestone; `content_json` carries `name`, `repo`, `forced`, `open_issues`, `remote_closed` |
| `agent_runs_capture_skipped` | `swe-atomic-close` could not bind a SWE spawn to a task (no `task_id=<N>` in the spawn transcript, or no such task) and wrote no `agent_runs` row; filed under the system issue `-1`; `content_json` carries `reason`, `transcript`, `spawn_id`, `task_id` |
| `task_escalated_repair` | The v33 migration escalated a task still `pending`/`running`/`needs_validation`/`completed` whose issue was already `closed` (GH 1212) and closed its open `agent_runs` rows as `issue_closed`; written by `system` on the task's issue; `content_json` carries `task_id`, `issue_id`, `from_status` |
| `containment_denied` | `containment-guard` denied a write outside the run's root (from_node `hook:containment-guard`, on the task's issue, else the system issue `-1`); `content_json` carries `tool`, `path`, `root`, `task_id` |
| `agent_runs_claimed` | `bro-turn-usage` claimed bro `agent_runs` rows opened without a `session_id` for its session (from_node `hook:bro-turn-usage`, one row per claim, on the rows' issue when they share one, else the system issue `-1`); `content_json` carries `run_ids`, `session_id` |
| `scan_discovered_repair` | The v32 migration deleted `scan_discovered` rows whose `(name, kind)` has no `cheatcodes` row (phantom discoveries from a failed insert); filed under the system issue `-1` by `system`; `content_json` carries `deleted` |
| `task_escalated_by_issue_close` | `issue_close(cascade: true)` escalated a live task (`pending`/`running`/`needs_validation`/`completed`) of the issue it closed and closed its open `agent_runs` rows as `issue_closed`; one row per task, from_node `bro`; `content_json` carries `task_id`, `from_status`, `reason` |
| `review_gate_waived` | `issue_close(waive_review: true)` closed an issue over a closed task with no passing pr-reviewer verdict for its current commit; one row per such task, from_node `bro`; `content_json` carries `skill`, `task_id`, `commit_sha`, `waive_review_reason` |
| `review_gate_bypassed` | A task reached `closed` by a path other than `bro_atomic_close` (`close-issue-on-merge`, `task_recover`, `task_update_status`) with no passing pr-reviewer verdict for its current commit; the task still closes. At most one row per task and commit (none when a `review_gate_waived` row already names them). from_node = the writer (`bro`, `hook:close-issue-on-merge`); `content_json` carries `task_id`, `commit_sha`, `closed_by`. A verdict counts as passing when `verdict = 'pass'` and its `created_at` is at or after the earliest `bro_verification_pass` row naming the task and its current `commit_sha`; with no such row there is no pass |
| `issue_auto_closed_on_merge` | `close-issue-on-merge` closed a local issue named by a merged PR's closing-ref (from_node `hook:close-issue-on-merge`); `content_json` carries `gh_iid` |
| `issue_auto_close_deferred` | `close-issue-on-merge` left an issue named by a merged PR's closing-ref open because other tasks of it are still live; `content_json` carries `blocking_task_ids`, `gh_iid` |
| `issue_auto_close_remote_skipped` | `close-issue-on-merge` closed an issue locally but not its GitHub twin because issue sync is off (`plugin_config.issue_sync` unset or `off`, or `TMB_DISABLE_REMOTE_SYNC` set); `content_json` carries `gh_iid`, `reason` |
| `task_stale_swept` | `task_recover` moved a `running` task with no open swe `agent_runs` row and no update for `TMB_STALE_RUNNING_HOURS` (default 6) to `failed` and closed its open runs as `swept_stale`; from_node `bro`; `content_json` carries `task_id`, `from_status`, `last_updated_at`, `stale_after_hours` |

**TMB-specific** — these are TMB workflow events. New event types require a row here. Bro should not invent ad-hoc event types.

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
| `installed` | Acquired via the discover → vet → install pipeline; `source_url` carries the candidate identity |

Schema enforces via `CHECK(origin IN ('builtin','installed'))`, plus paired `CHECK`s: `installed` rows require `source_url`, `builtin` rows forbid it.

### `cheatcodes.scope` — where the capability lives

| Value | Meaning |
|---|---|
| `global` | Plugin-shipped / user-wide |
| `template` | `templates/` copied per-project on demand |
| `project-local` | `<project>/.claude/` authored locally |

Schema enforces via `CHECK(scope IN ('global','template','project-local'))`. The `agents.scope` column uses the same three-value vocabulary.

### `cheatcodes.status` — install lifecycle

| Value | Meaning |
|---|---|
| `installed` | Recorded but not confirmed loaded (new installs land here) |
| `active` | Loaded / usable (builtin skills seed here) |
| `broken` | Recorded but failed (e.g. an uninstall whose teardown left the artifact on disk) |

No `CHECK` constraint — runtime reconciliation to `active`/`broken` is the health-check's job. `trust_tier` is free-form text carrying the vet classification for installed rows and the curation tier (`curated`) for builtin ones.

### `plugin_meta.schema_version` — DB schema version (integer)

Currently `33`. Bumped on any breaking schema change. **NOT free-form** — every increment requires a migration step in `db.ts:runMigrations`.

### `agent_runs.usage_source` — where a run's token values came from

| Value | Meaning |
|---|---|
| `transcript` | Measured by the bro Stop hook from the session transcript (bro rows) |
| `subagent_stop` | Measured by the SubagentStop hook from the spawn's transcript (swe rows) |
| `unmeasured` | The run closed without a measurement; the four token columns are NULL |
| `backfill` | Recreated after the fact from an archived transcript (a maintenance backfill, not a live hook) |

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

Common values: `swe`, `pr-reviewer`, `architect`, `cto`, `pm`, `ceo`. Open enum — accept any string. Document the canonical values for query convenience.

### `repos.remotes[].provider` — git host provider per remote

| Value | Meaning |
|---|---|
| `github` | github.com or GitHub Enterprise |
| `gitlab` | gitlab.com or self-hosted GitLab |
| `bitbucket` | Atlassian's git host (bitbucket.org) |
| `codeberg` | codeberg.org (Forgejo-based public forge) |
| `azuredev` | Azure DevOps (dev.azure.com) |
| `other` | Unrecognised or custom host |

URL-pattern auto-detection rules:

- `github.com` → `github`
- `gitlab.com` or `gitlab.<corp>.<tld>` → `gitlab`
- `bitbucket.org` → `bitbucket`
- `codeberg.org` → `codeberg`
- `dev.azure.com` → `azuredev`
- everything else → `other`

`remotes` is a `repos`-table column whose value is a JSON array of `{ name, provider, url }` objects (e.g. `[{ "name": "origin", "provider": "github", "url": "git@github.com:org/repo.git" }]`). An empty array means no remote is configured.

---

## How to add a new ENUM value

1. Open a PR that adds the value to this doc AND to the schema/code that consumes it.
2. Add a test that covers the new value's path.
3. Update `tests/l1-lint/enums-stable.sh` if it has a hardcoded list.

---

## Lint guard

`tests/l1-lint/enums-stable.sh` checks that this doc and `mcp/trajectory-server/src/schema.sql` agree on the ENUM-bearing columns. Drift fails CI.

---

## Related

- [`LABELS.md`](./LABELS.md) — same governance rule for GH issue labels and `issue_labels` DB table (when shipped, see #38)
- `mcp/trajectory-server/src/schema.sql` — schema source of truth
- `mcp/trajectory-server/docs/CONFIG_KEYS.md` — `plugin_config` key registry (different doc because keys are looser than ENUMs)
