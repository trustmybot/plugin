# @trustmybot/trajectory-server

MCP stdio server that persists TMB workflow trajectory to SQLite. The Claude package starts `dist/index.js` through the root `.mcp.json`; the Codex package starts the isolated `dist/codex.js` through `adapters/codex/.mcp.json`.

## Build & run

```sh
bun install
bun run build
node dist/index.js
```

(The plugin spawns this automatically via `.mcp.json` — manual run is only needed for isolated testing.)

The build also writes `scripts/hooks/lib/audit-events.txt` (via `scripts/maintenance/gen-enums-doc.mjs --txt`): the closed `audit.event_type` set from `src/audit-events.ts`, one `event<TAB>writers` line per event, that the hooks validate against. `writers` names who may author each event; `audit_append` refuses a caller whose role is not listed (`audit_event_not_writable_by_role`) and records `from_node` as the caller. After adding an event type, run `node scripts/maintenance/gen-enums-doc.mjs` from the plugin root to regenerate the `audit.event_type` table in `docs/contributing/ENUMS.md`. The build also regenerates `scripts/hooks/lib/data-contracts.json` (the SessionStart banner's copy of the data contracts) via `scripts/maintenance/emit-data-contracts.mjs`. After a schema change, run `node scripts/maintenance/gen-erd-doc.mjs` to regenerate `docs/architecture/ERD.md`; after adding a `plugin_config` key, give it a `KEYS` entry in `scripts/maintenance/gen-config-keys-doc.mjs` and run that script to regenerate [`docs/reference/CONFIG_KEYS.md`](../../docs/reference/CONFIG_KEYS.md).

The Codex entry exposes an immutable 15-tool adapter registry: 13 local Bro planning tools plus `agent_materialization_get` and `agent_materialization_set`. Every call requires an explicit Git worktree root with `.tmb/` already ignored and no tracked `.tmb/` files. Planning state stays beneath `<project>/.tmb/tmb/`.

The two materialization tools manage only `.codex/agents/tmb_swe.toml` and `.codex/agents/tmb_pr_reviewer.toml`. The getter is read-only and does not create `.tmb` or `.codex`. The setter installs or removes both current templates without overwriting unknown bytes. It rejects symlinks and unexpected file types, preserves all third-party Agent files, and reports a partial result if one managed target changes before a later failure. Scope 4 intentionally has no historical-template upgrades, process lock, rollback, fsync, or crash recovery.

The Codex entry does not import the Claude tool registry, write `.claude/`, create workflow tasks or validation records, or perform Git delivery operations.

See the [Codex MCP tool reference](../../docs/adapters/codex/TOOLS.md) for the
exact materialization schemas, states, results, and recovery errors.

## Test

```sh
node --test dist/test/*.test.js
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `TRAJECTORY_DB_PATH` | `<CLAUDE_PROJECT_DIR>/.claude/<plugin-name>/trajectory.db`; without a project root, the outermost existing DB walking up from `<cwd>` — see [Where the trajectory DB lives](../../docs/reference/TRAJECTORY_DB_LOCATION.md) | Absolute path to the SQLite database, or `:memory:` for ephemeral runs. Filenames `world-model.kuzu` and `*.world-model.kuzu` are reserved for graph storage and rejected. |
| `TMB_EMBED_FAIL_THRESHOLD` | `5` | Consecutive failed embed calls that put the embedding model in the degraded state (see [Health](#health)). |
| `TMB_EMBED_RETRY_MS` | unset (1 min, 5 min, then every 10 min) | One fixed delay between degraded-state re-attempts, for tests. |

Default is project-local, per-user, gitignored (the plugin-root `.gitignore` excludes `.claude/`). The `<plugin-name>` segment is read from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`'s `name` field. Both stable and RC channels currently ship `name=tmb`, so both resolve to `.claude/tmb/` — install only one channel at a time to avoid DB collision. The hooks resolve the same DB by the same rule ([`docs/reference/TRAJECTORY_DB_LOCATION.md`](../../docs/reference/TRAJECTORY_DB_LOCATION.md)). Set the env var to override for CI, isolated tests, or shared testbeds.

Server logs (`mcp-server.log`, `sql.log`, `issue-sync.log`) live in `logs/` beside the trajectory DB; an in-memory DB logs to the OS temp dir. The server writes nothing under the user's home; the one path outside the project is the embedding model cache, `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`).

`TrajectoryDB` has two construction modes. The existing one-argument constructor keeps Claude behavior and discovers `plugin_version` from `CLAUDE_PLUGIN_ROOT`. Supplying `TrajectoryDBDependencies` switches to an authoritative explicit mode: the provided `pluginVersion`, `serverLog`, and `sqlLog` are used without falling back to Claude process state; `pluginVersion: null` deliberately disables version synchronization. Logger callback failures are isolated and never change a database operation's result.

Codex-bound consumers pass the context's canonical `projectRoot` as `trustedProjectRoot` when creating a project logger, `TrajectoryDB`, or `WorldModelGraph`. Each consumer then revalidates its target immediately before creating or opening state. Explicit project loggers also reject symlink leaves and create new log files with mode `0600` on POSIX; the legacy Claude singleton keeps its existing append semantics. This is a fail-closed guard against path replacement between context resolution and use, not a claim of atomic protection against a same-user filesystem mutation in the final syscall window.

## Health

The embedding model (`src/embeddings/model.ts`) reports its state through `embeddingStatus()`: `{state: 'ready'|'degraded'|'loading'|'disabled', since?, reason?, consecutive_failures, next_retry_at?}` (`disabled` = no load attempted yet). `trajectory_doctor` returns it as `embeddings` beside the data-contract report, and every degraded / recovered transition logs an `embeddings_state` line with it to `mcp-server.log`.

A model that cannot load enters `degraded` at once; a failed embed call is only counted, and `TMB_EMBED_FAIL_THRESHOLD` (default 5) consecutive failures enter `degraded` too; any success resets the count. While degraded, embedding returns nothing — search and embed-at-write use FTS only, with unchanged result shapes — until a re-attempt (rebuild the model, then embed) is due: 1 min after entering, then 5 min, then every 10 min (`TMB_EMBED_RETRY_MS` sets one fixed delay, for tests). Tests drive the schedule deterministically through `__setClockForTests(fn)`, which replaces the clock behind `since`, `next_retry_at` and the re-attempt gate (default `Date.now`). A successful re-attempt returns to `ready`. Each episode writes one `embeddings_degraded` audit row on the system issue `-1` and one `embeddings_recovered` row when it clears; the `embeddings_not_degraded` warn contract flags a degraded row from the last 24 hours with no later recovery.

## Tool families

Tools are registered in `src/tools/index.ts`, grouped by domain:

| Family | File | Example tools |
|---|---|---|
| Issues | `tools/issues.ts` | `issue_create`, `issue_get`, `issue_list`, `issue_resume`, `issue_close`, `issue_link`, `issue_adopt_remote` |
| Milestones | `tools/milestones.ts` | `milestone_close` (reconcile + seed run inside `scan_run`) |
| Tasks | `tools/tasks.ts` | `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable` |
| Task composites | `tools/composites.ts` | `task_provision`, `task_brief`, `task_retry`, `task_recover`, `task_reopen` (bro: closed/failed/escalated/running → running, widen fences, recreate the worktree), `task_update_spec` (bro: replace files/verification/spec_body of a live task), `bro_atomic_close` |
| Discussions | `tools/discussions.ts` | `discussion_append`, `discussion_list`, `discussion_search`, `issue_get_with_discussions` |
| Audit | `tools/audit.ts` | `audit_append`, `audit_list`, `audit_search` |
| Validation | `tools/validation.ts` | `validation_record`, `validation_history` |
| Skills (builtin rows in the unified `cheatcodes` registry, #101) | `tools/skills.ts` | `skill_register` (takes `scope`), `skill_promote` |
| Agents | `tools/agents.ts` | `agent_register`, `agent_list` (filter `root`), `agent_resolve` (bro) — `file_path` is `plugin:<path>` or `project:<path>`; rows carry `resolved_path` |
| Reports | `tools/reports.ts` | `issue_report_md`, `issue_snapshot_md` |
| Branch report | `tools/branch_report_md.ts` | `branch_report_md` |
| Stats | `tools/stats.ts` | `task_stats` (token/duration aggregate per task; `cost_estimate` from `plugin_config.model_prices`) |
| Roundtable | `tools/roundtable.ts` | `roundtable_create`, `roundtable_vote`, `roundtable_summarize`, `roundtable_finalize_decisions`, `roundtable_close`, `roundtable_close_with_decisions` |
| PR monitor | `tools/pr_monitor.ts` | `pr_monitor_comments_get`, `pr_monitor_runs_list` |
| Cheatcodes | `tools/cheatcode.ts` | `cheatcode_search`, `cheatcode_vet`, `cheatcode_approve`, `cheatcode_install`, `cheatcode_activate`, `cheatcode_uninstall`, `cheatcode_list` |
| Config | `tools/config.ts` | `config_get`, `config_set`, `config_list` |
| Onboard | `tools/onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` |
| Scan (workspace + repos) | `tools/scan.ts` | `scan_run` (forks `scripts/scan.sh` for deterministic discovery; returns `rename_candidates`), `repos_list` |
| Repos | `tools/repos.ts` | `repo_rename` (bro only; moves the `repos` row, its FK children, `pr_review_runs` slugs and world-model nodes in one transaction) |
| World model | `tools/world_model.ts` | `world_model_get`, `world_model_search` → kuzu graph DB |
| Metering backfill | `tools/agent-runs-backfill.ts` | `agent_runs_backfill` (bro: recover swe/pr-reviewer/bro `agent_runs` from Claude Code transcripts on disk, `usage_source = 'backfill'`, dry run by default) |
| Data contracts | `tools/trajectory-doctor.ts` | `trajectory_doctor` (bro, read-only: runs `DATA_CONTRACTS` from `src/data-contracts.ts`; `record: true` logs one `trajectory_doctor_run` audit row) |

Role-gating is enforced per-tool via `requireRoles()` in `middleware/agent-scope.ts`. Valid first-class roles: `bro`, `swe`, `pr-reviewer`. Consultant roles (`architect`, `cto`, `ceo`, `pm`, and any user-created agent name) are accepted as open-enum values; the server grants them consultant-level access.

## `branch_id` format

Every task's `branch_id` must follow the git-convention format:

```
<type>/<slug>
```

where `<type>` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `build`, `ci`, `style`, or `revert`, and `<slug>` is lowercase alphanumeric with hyphens (max 63 chars, must start with an alnum character). Examples: `feat/user-login`, `fix/auth-crash`, `refactor/extract-helper`.

`branch_id` doubles as the working git branch name for the task's worktree. `task_first_actionable` returns tasks in lexicographic order of `branch_id`, which groups them by type prefix.

## Schema

Current baseline: `TARGET_SCHEMA_VERSION = 37` (see `src/db.ts`). `schema.sql` is applied on open via `CREATE TABLE IF NOT EXISTS` semantics. On open, the stored `schema_version` is compared against `TARGET_SCHEMA_VERSION` via `db.ts:runMigrations`; if behind, a `.bak` snapshot is written before any migration runs, then migrations execute in sequence and `schema_version` is updated on success. Rollback is via the `.bak` file. Migration correctness is covered by `src/test/schema-upgrade.test.ts`.

`plugin_meta` tracks `schema_version` + `plugin_version`. In the default Claude constructor mode, `plugin_version` is synced dynamically from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` on every construction, so fresh and existing DBs auto-update without a migration. Explicit dependency mode instead treats its supplied version as authoritative; `null` performs no synchronization. The schema placeholder `'0.0.0'` applies when no version is supplied.
