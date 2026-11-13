# @trustmybot/trajectory-server

MCP stdio server that persists TMB workflow trajectory to SQLite. The plugin starts `dist/index.js` through the root `.mcp.json`.

## Build & run

```sh
bun install
bun run build
node dist/index.js
```

(The plugin spawns this automatically via `.mcp.json` — manual run is only needed for isolated testing.)

The build also writes `scripts/hooks/lib/audit-events.txt` (via `scripts/maintenance/gen-enums-doc.mjs --txt`): the closed `audit.event_type` set from `src/audit-events.ts`, one `event<TAB>writers` line per event, that the hooks validate against. `writers` names who may author each event; `audit_append` refuses a caller whose role is not listed (`audit_event_not_writable_by_role`) and records `from_node` as the caller. After adding an event type, run `node scripts/maintenance/gen-enums-doc.mjs` from the plugin root to regenerate the `audit.event_type` table in `docs/contributing/ENUMS.md`. The build also regenerates `scripts/hooks/lib/data-contracts.json` (the SessionStart banner's copy of the data contracts) via `scripts/maintenance/emit-data-contracts.mjs`. After a schema change, run `node scripts/maintenance/gen-erd-doc.mjs` to regenerate `docs/architecture/ERD.md`; after adding a `plugin_config` key, give it a `KEYS` entry in `scripts/maintenance/gen-config-keys-doc.mjs` and run that script to regenerate [`docs/architecture/CONFIG_KEYS.md`](../../docs/architecture/CONFIG_KEYS.md).

## Worktree setup

A repo opts in to a build step for every worktree TMB makes with `.config/tmb/worktree-setup.json` (GH 2054):

```json
{ "version": 1, "commands": ["bun run build:payload"] }
```

`src/utils/worktree-setup.ts` reads the file from the worktree's own checkout and runs each command in order through `bash -c` in the worktree, with the user's toolchain PATH, stopping at the first failure; each command has a 10-minute timeout. No file is a no-op. A malformed file (bad JSON, `version` not 1, `commands` not a non-empty array of non-empty strings) is a setup failure, never skipped. The commands carry the same trust as `verification[]`. Setup runs right after the worktree gets its dependencies. Each tracked dir holding a lockfile is an install root for the package dirs nearest beneath it, provided the main checkout installed it (its counterpart there has a `node_modules` dir); a lockfile dir main never installed, such as a test fixture, is no root. The install runs per installed lockfile root whose manifests differ: when a root's lockfile or any `package.json` in its group differs from the main checkout's, the lockfile's frozen install (`bun install --frozen-lockfile`, `npm ci`, `pnpm install --frozen-lockfile` or `yarn install --frozen-lockfile`) runs in that root, one root at a time, stopping at the first failure (GH 3003). Every other package dir, including one under no lockfile, gets the main checkout's `node_modules` linked in. A failed install fails the same way a setup command does, except in the environment gate, where it is best-effort:

- `task_provision`, `task_reopen`, `task_retry`: the setup stage of their environment gate (GH 2866), which runs fetch, branch, worktree, setup and reindex before any row is written. A failed stage refuses the call with `env_gate_failed` (`stage`, `detail`, `output_tail`), writes nothing and removes the branch and worktree the call created. A pass carries `worktree_setup` (`ran`, `commands[]` with `exit_code` / `timed_out` / `elapsed_ms`), `env_gate.stages`, and the `base_sha` and `wm_commit` recorded on the task.
- `cli.js integrate`: before `verification[]`; a failure exits 1 with the failing command and its output tail on stderr.
- `pr_monitor_worktree`: before the reviewer's command; a failure returns an error naming the command, and the worktree is still removed.
- `swe-verification-gate`: before a run that is not reused; a failure denies the close with the command and its output tail. Setup counts against the verification budget: each command gets at most what is left of it, `verification[]` gets what setup leaves, and a setup that spends it denies. Setup is not recorded as a verification command.

This repo's own file runs `bun run build:payload`.

## Doc checks

Before swe's close runs `verification[]`, `swe-verification-gate` checks the commit for a changelog entry and for docs that still cite a path or tool name the branch removed (GH 2866). A repo tells it where to look with `.config/tmb/doc-checks.json`, read as committed at the worktree HEAD:

```json
{
  "version": 1,
  "changelog_dir": "notes/changes",
  "doc_paths": ["documentation/**/*.md", "README.md"],
  "tool_sources": ["tools/*.py"],
  "tool_name_pattern": "^def cmd_([a-z_]+)\\("
}
```

Every key but `version` is optional. `changelog_dir` turns on the changelog check, `doc_paths` the stale-reference check, and `tool_sources` with `tool_name_pattern` (one capture group: the tool name) its removed-tool half. A missing file or key skips that check, and the close says which key to add. An invalid file blocks the close and shows the expected shape. This repo's own file holds the plugin's layout.

## Leak scan

Beside the doc checks, the close scans only the lines the branch adds since its merge base (GH 2929) for secrets (secretlint's recommended preset, bundled into `dist/hooks.js`), email addresses (`email`) and home paths such as `/Users/<name>/`, `/home/<name>/` or `C:\Users\<name>\` (`home_path`). A hit blocks the close with check `leak_scan` and lists each one as `<file>:<line> <rule>`, never the matched text. Deletions and binary files are skipped, and inline `secretlint-disable` comments are not honored. `noreply@` addresses, addresses at `example.com`, `example.org` or `example.net`, and home paths whose name is a `<placeholder>`, `user`, `me`, `you` or `runner` always pass. A repo admits more, or turns a rule off, with `.config/tmb/leak-scan.json`, read as committed at the worktree HEAD:

```json
{
  "version": 1,
  "allow": [{ "rule": "email", "pattern": "@corp\\.example$", "reason": "the public team alias" }],
  "disable_rules": [{ "rule": "home_path", "reason": "docs show real layouts" }]
}
```

`pattern` is a JavaScript regex tested against the matched text; an allow entry without `rule` covers every rule. A secretlint rule is named by its id, such as `@secretlint/secretlint-rule-github`. Every entry needs a non-empty `reason`, and an invalid file blocks the close as `leak_scan_config`. A git or scanner failure blocks the close too.

## Test

```sh
node --test dist/test/*.test.js
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `TRAJECTORY_DB_PATH` | `<CLAUDE_PROJECT_DIR>/.claude/<plugin-name>/trajectory.db`; without a project root, the outermost existing DB walking up from `<cwd>` — see [Where the trajectory DB lives](../../docs/architecture/MEMORY.md#where-the-trajectory-db-lives) | Absolute path to the SQLite database, or `:memory:` for ephemeral runs. |
| `TMB_EMBED_FAIL_THRESHOLD` | `5` | Consecutive failed embed calls that put the embedding model in the degraded state (see [Health](#health)). |
| `TMB_EMBED_RETRY_MS` | unset (1 min, 5 min, then every 10 min) | One fixed delay between degraded-state re-attempts, for tests. |

Default is project-local, per-user, gitignored (the plugin-root `.gitignore` excludes `.claude/`). The `<plugin-name>` segment is read from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`'s `name` field. Both stable and RC channels currently ship `name=tmb`, so both resolve to `.claude/tmb/` — install only one channel at a time to avoid DB collision. The hooks resolve the same DB by the same rule ([`docs/architecture/MEMORY.md#where-the-trajectory-db-lives`](../../docs/architecture/MEMORY.md#where-the-trajectory-db-lives)). Set the env var to override for CI, isolated tests, or shared testbeds.

Server logs (`mcp-server.log`, `sql.log`, `issue-sync.log`) live in `logs/` beside the trajectory DB; an in-memory DB logs to the OS temp dir. The server writes nothing under the user's home; the one path outside the project is the embedding model cache, `TMB_MODEL_CACHE_DIR` (default `HF_HOME`, else `~/.cache/huggingface`).

`TrajectoryDB` has two construction modes. The existing one-argument constructor keeps Claude behavior and discovers `plugin_version` from `CLAUDE_PLUGIN_ROOT`. Supplying `TrajectoryDBDependencies` switches to an authoritative explicit mode: the provided `pluginVersion`, `serverLog`, and `sqlLog` are used without falling back to Claude process state; `pluginVersion: null` deliberately disables version synchronization. Logger callback failures are isolated and never change a database operation's result.

Explicit project loggers reject symlink leaves and create new log files with mode `0600` on POSIX; the default Claude singleton keeps its existing append semantics.

## Health

The embedding model (`src/embeddings/model.ts`) reports its state through `embeddingStatus()`: `{state: 'ready'|'degraded'|'loading'|'disabled', since?, reason?, consecutive_failures, next_retry_at?}` (`disabled` = no load attempted yet). `trajectory_doctor` returns it as `embeddings` beside the data-contract report, and every degraded / recovered transition logs an `embeddings_state` line with it to `mcp-server.log`.

A model that cannot load enters `degraded` at once; a failed embed call is only counted, and `TMB_EMBED_FAIL_THRESHOLD` (default 5) consecutive failures enter `degraded` too; any success resets the count. While degraded, embedding returns nothing — search and embed-at-write use FTS only, with unchanged result shapes — until a re-attempt (rebuild the model, then embed) is due: 1 min after entering, then 5 min, then every 10 min (`TMB_EMBED_RETRY_MS` sets one fixed delay, for tests). Tests drive the schedule deterministically through `__setClockForTests(fn)`, which replaces the clock behind `since`, `next_retry_at` and the re-attempt gate (default `Date.now`). A successful re-attempt returns to `ready`. Each episode writes one `embeddings_degraded` audit row on the system issue `-1` and one `embeddings_recovered` row when it clears; the `embeddings_not_degraded` warn contract flags a degraded row from the last 24 hours with no later recovery.

## Tool families

Tools are registered in `src/tools/index.ts`, grouped by domain:

| Family | File | Example tools |
|---|---|---|
| Issues | `tools/issues.ts` | `issue_create`, `issue_get`, `issue_list`, `issue_resume`, `issue_close`, `issue_link`, `issue_adopt_remote` |
| Milestones | `tools/milestones.ts` | `milestone_close` (reconcile + seed run inside `scan_run`) |
| Tasks | `tools/tasks.ts` | `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable`, `task_rework_analysis` |
| Task composites | `tools/composites.ts` | `task_provision`, `task_brief` (optional `section`: `core` \| `verification` \| `scope` \| `history` \| `all`; default `core` for swe, `all` for every other caller; optional `response_format`: `concise` by default, `detailed` for world-model summaries and full discussion rows), `task_retry`, `task_recover`, `task_reopen` (bro: pending/completed/closed/failed/escalated/running → running, completed for a review FAIL, widen fences, recreate the worktree), `task_update_spec` (bro: replace files/verification/spec_body of a live task), `review_handoff` (bro: hand a completed task's commit to code-reviewer, status unchanged), `bro_atomic_close` (bro: close after code-reviewer's pass) |
| Discussions | `tools/discussions.ts` | `discussion_append`, `discussion_list`, `discussion_search`, `issue_get_with_discussions` |
| Audit | `tools/audit.ts` | `audit_append`, `audit_list`, `audit_search` |
| Validation | `tools/validation.ts` | `validation_record`, `validation_history` |
| Skills (builtin rows in the unified `cheatcodes` registry, #101) | `tools/skills.ts` | `skill_register` (takes `scope`), `skill_promote` |
| Agents | `tools/agents.ts` | `agent_register`, `agent_list` (filter `root`), `agent_resolve` (bro) — `file_path` is `plugin:<path>` or `project:<path>`; rows carry `resolved_path` |
| Reports | `tools/reports.ts` | `issue_report_md`, `issue_snapshot_md` |
| Branch report | `tools/branch_report_md.ts` | `branch_report_md` |
| Stats | `tools/stats.ts` | `task_stats` (token/duration aggregate per task; `cost_estimate` from `plugin_config.model_prices`) |
| Change impact | `tools/change-impact.ts` | `change_impact` (read-only before/after statistics on the agent metrics for one change `{source, id, repo?}`, a plugin version, an agent-surface commit, or a cheatcode install, uninstall or config change, from `src/change-impact/`) |
| Roundtable | `tools/roundtable.ts` | `roundtable_create`, `roundtable_vote`, `roundtable_summarize`, `roundtable_finalize_decisions`, `roundtable_close`, `roundtable_close_with_decisions` |
| PR monitor | `tools/pr_monitor.ts` | `pr_monitor_comments_get`, `pr_monitor_runs_list` |
| Cheatcodes | `tools/cheatcode.ts` | `cheatcode_search`, `cheatcode_vet`, `cheatcode_approve`, `cheatcode_install`, `cheatcode_activate`, `cheatcode_uninstall`, `cheatcode_list`, `cheatcode_reconcile` |
| Config | `tools/config.ts` | `config_get`, `config_set`, `config_list` |
| Onboard | `tools/onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` |
| Scan (workspace + repos) | `tools/scan.ts`, `tools/scan-walk.ts` | `scan_run` (runs the in-process `walkProject` walker for deterministic discovery; returns `rename_candidates`), `repos_list` |
| Repos | `tools/repos.ts` | `repo_rename` (bro only; moves the `repos` row, its FK children, `pr_review_runs` slugs and world-model nodes in one transaction) |
| World model | `tools/world_model.ts` | `world_model_get`, `world_model_search`, `world_model_symbol`, `world_model_concepts`, `world_model_concept_get`, `world_model_concept_upsert`, `scope_suggest` → `wm_` tables (`world_model_symbol` takes `impact` for transitive callers and `source: true` for the body from disk; symbol cards and hits carry `stale`; after connect the server spawns a detached catch-up `run-scan.mjs`, `startup-catchup.ts`). Concepts follow propose → review → apply: swe proposes up to 5 in `task_update_status`'s `report.concepts`, code-reviewer passes the task, and the next `scan_run` upserts each proposal (`world-model/concepts.ts` `applyConceptProposals`, audit `concept_proposal_applied`). One that still fails 14 days after the close gets `concept_proposal_rejected` |
| Metering backfill | `tools/agent-runs-backfill.ts` | `agent_runs_backfill` (bro: recover swe/code-reviewer/bro `agent_runs` from Claude Code transcripts on disk, `usage_source = 'backfill'`, dry run by default) |
| Data contracts | `tools/trajectory-doctor.ts` | `trajectory_doctor` (bro, read-only: runs `DATA_CONTRACTS` from `src/data-contracts.ts`; `record: true` logs one `trajectory_doctor_run` audit row) |
| Bug report | `tools/bug-report.ts` | `bug_report_draft` (bro only: drafts a redacted TMB bug report through the pure `src/bug-report/` modules (form, redact, render) and files nothing. It is refused unless `bug_report_consent` is `yes` or `user_asked` is true. `already_filed` comes from the newest `bug_report_filed` audit row with the same signature) |
| Env | `tools/env.ts` | `env_detect` (any agent: the pure `src/env/` collector reads manifests, lockfiles, configs, CI steps and task-runner targets per package root and runs nothing), `env_record` (bro only: upserts `repo_env` profiles), `env_get` (profiles with `effective_commands`, overrides over commands) |

Role-gating is enforced per-tool via `requireRoles()` in `middleware/agent-scope.ts`. Valid first-class roles: `bro`, `swe`, `code-reviewer`. Consultant roles (`architect`, `cto`, `ceo`, `pm`, and any user-created agent name) are accepted as open-enum values; the server grants them consultant-level access.

## `branch_id` format

Every task's `branch_id` must follow the git-convention format:

```
<type>/<slug>
```

where `<type>` is one of `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `build`, `ci`, `style`, or `revert`, and `<slug>` is lowercase alphanumeric with hyphens (max 63 chars, must start with an alnum character). Examples: `feat/user-login`, `fix/auth-crash`, `refactor/extract-helper`.

`branch_id` doubles as the working git branch name for the task's worktree. `task_first_actionable` returns tasks in lexicographic order of `branch_id`, which groups them by type prefix.

## Schema

Current baseline: `TARGET_SCHEMA_VERSION = 41` (see `src/db.ts`). `schema.sql` is applied on open via `CREATE TABLE IF NOT EXISTS` semantics. On open, the stored `schema_version` is compared against `TARGET_SCHEMA_VERSION` via `db.ts:runMigrations`; if behind, a `.bak` snapshot is written before any migration runs, then migrations execute in sequence and `schema_version` is updated on success. Rollback is via the `.bak` file. Migration correctness is covered by `src/test/schema-upgrade.test.ts`.

`plugin_meta` tracks `schema_version` + `plugin_version`. In the default Claude constructor mode, `plugin_version` is synced dynamically from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` on every construction, so fresh and existing DBs auto-update without a migration. Explicit dependency mode instead treats its supplied version as authoritative; `null` performs no synchronization. The schema placeholder `'0.0.0'` applies when no version is supplied.
