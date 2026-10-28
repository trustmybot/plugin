# Reference pointers

Lookups bro hits occasionally — keep here so they don't bloat CLAUDE.md.

## Where state lives

- **Trajectory DB** — SQLite at `<project>/.claude/<plugin-name>/trajectory.db`. Holds the workflow audit: issues, tasks, discussions, audit, validation, plugin metadata. The `<plugin-name>` segment resolves from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`'s `name` field; today that's `tmb` for both stable and RC channels, so both write to `.claude/tmb/`. Project-local, gitignored, per-developer.
- **World model** — the `wm_directories` / `wm_files` tables (plus FTS5 and embedding side tables) in the same trajectory DB. Holds bro's project mental picture: directories with summaries and files with a one-line purpose and content hash, rebuilt by `/scan`. `wm_files.purpose_source` names the purpose's writer: `swe`; a file header (`docstring`, `comment`, `jsdoc`, `frontmatter`, `heading`, `manifest`); the header-less fallbacks `structural` (data files) and `symbols` (code files, from the symbol index); or `none`. See `docs/architecture/WORLD_MODEL.md`.
- **Task specs** — `tasks.spec_body` column, fetched via `task_get(task_id)`. NOT on disk.
- **Issue milestone** — `issues.milestone` column (nullable `TEXT`), a composite FK `(milestone, repo)` into the per-repo `milestones` table (#155, schema v23). See `docs/architecture/ERD.md`.
- **Architectural decisions** — recorded as `kind=decision` discussions in the trajectory DB.
- **Snapshots** — `docs/trustmybot/snapshots/<issue_id>.md`, generated via `issue_snapshot_md`.

## Other docs

- **Prompt-engineering guide (authoring agent prompts)** — [`PROMPT_ENGINEERING.md`](../prompt-engineering/PROMPT_ENGINEERING.md)
- **Agent layer model + override rules** — [`architecture/RESPONSIBILITIES.md`](../architecture/RESPONSIBILITIES.md)
- **plugin_config keys** — [`CONFIG_KEYS.md`](./CONFIG_KEYS.md)
- **Full architecture** — `docs/architecture/FLOWS.md`

## MCP tools (full list)

79 tools across these groups (full schema in `mcp/trajectory-server/src/tools/`):

- **issues**: `issue_create`, `issue_get`, `issue_list`, `issue_close`, `issue_link`, `issue_update_description`, `issue_update`, `issue_resume`, `issue_get_phase`, `issue_sync_retry`, `issue_adopt_remote`. The write tools return the issue row without its description; `issue_create`, `issue_update_description`, `issue_link` and `issue_adopt_remote` take `include_description: true` to echo it (bro/architect, as on `issue_get`). `issue_adopt_remote` takes an optional `repo` (a `repos` row name) to verify against; a repo-less issue in a multi-repo workspace needs it (`repo_unresolved` otherwise), and a successful adoption backfills the issue's null repo and copies the remote's milestone and labels into columns that are empty locally. `issue_update` (bro) changes an issue's `milestone`, `labels` (a full replacement set, validated like `issue_create`) or `objective` after creation, writes an `issue_updated` audit row with before/after, and mirrors the change to the linked gh/glab issue when `issue_sync` is on; its `_sync` field reports whether the mirror ran.
- **milestones**: `milestone_close`
- **tasks**: `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable`
- **stats**: `task_stats`
- **discussions**: `discussion_append` (refuses author='human'; only the `rework-waiver-capture` hook writes Human rows), `discussion_list`, `discussion_search`, `issue_get_with_discussions`
- **roundtable**: `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_close_with_decisions`, `roundtable_finalize_decisions`, `roundtable_summarize` (state machine: collecting → awaiting_human → closed | skipped)
- **pr_monitor**: `pr_monitor_comments_get` (gh + glab backends; bot detection via DEFAULT_BOT_PATTERNS), `pr_monitor_runs_list`
- **validation**: `validation_record` (subagent_session_id required when agent='code-reviewer'), `validation_history`
- **world model** (bro's directory-level memory): `world_model_get` (annotated dir tree; a zoomed-in dir lists its files with purposes, the root call adds purpose coverage), `world_model_search` (keyword / semantic / hybrid over dirs, files and symbols, each hit tagged `kind`; symbol hits carry `stale` when the file changed on disk since the last scan), `world_model_symbol` (one symbol's callers, callees, imports, tables read and written, and tests, plus `symbol.stale`; `impact` adds transitive callers by depth and the tests reached, `source: true` the body read from disk, framed as untrusted content), `world_model_concepts` (search agent-written flows; a derived, unverified chain when none match), `world_model_concept_get` (one concept's ordered steps with per-step trust), `world_model_concept_upsert` (bro and consultants write a concept whose steps and claims check out). swe proposes concepts at close instead, in `task_update_status`'s `report.concepts` (at most 5, repo defaulting to the task's). `scan_run` applies a proposal once its task is closed with a passing code-reviewer verdict and its anchors are in the index (`concept_proposal_applied`). A proposal that still fails 14 days after the close is dropped with `concept_proposal_rejected`, and `trajectory_doctor` warns on stale, rejected and missing concepts
- **onboard**: `onboard_state_get`, `onboard_get_questions`, `onboard_apply`
- **config**: `config_get`, `config_list`, `config_set`
- **scan**: `scan_run`, `repos_list`
- **repos**: `repo_rename`
- **reports**: `issue_report_md`, `issue_snapshot_md`, `branch_report_md`
- **cheatcodes** (unified skill/agent registry): `cheatcode_list`, `cheatcode_search`, `cheatcode_install`, `cheatcode_activate`, `cheatcode_approve`, `cheatcode_vet`, `cheatcode_uninstall`, `cheatcode_reconcile`
- **skills** (builtin rows in the `cheatcodes` registry): `skill_register`, `skill_promote`
- **agents**: `agent_list`, `agent_register`, `agent_resolve`
- **composites**: `intent_start`, `branch_id_propose`, `task_provision`, `task_brief`, `task_retry`, `task_recover`, `task_reopen`, `task_update_spec`, `bro_atomic_close`, `bro_verification_fail_record`, `pr_monitor_worktree`, `worktree_commits_fetch`
- **audit**: `audit_append`, `audit_list`, `audit_search`
- **metering backfill**: `agent_runs_backfill`
- **data contracts**: `trajectory_doctor`

## Slash commands

- `/roundtable <topic>` — multi-agent deliberation with checkbox/radio AUQ ratification (full procedure in `commands/roundtable.md`)
- `/onboard` — interactive policy ceremony with two branches based on project shape (local-only vs remote-tracked). Auto-fired on first contact when `plugin_config('onboarded')` is unset; Human-typed for later changes (full procedure in `commands/onboard.md`)
- `/monitor <PR_number>` — invokes `tmb_comment-triage` skill: fetches review comments, plans tasks, dispatches SWE per ratified comment
- `/scan` — triggers `scan_run` to rebuild the world model (`wm_directories` / `wm_files` in the trajectory DB) and refresh the repos registry
- `/tmb:agent-create <role> <question>` — spawns a consultant subagent with the given domain role and seed question

Runtime location: `plugin/commands/<name>.md`.

## Logs

All under the project, beside the trajectory DB (`<project>/.claude/tmb/logs/`); TMB writes nothing under `~/.claude`:

- `<date>-<session-id>.jsonl` — per-session CC log capture
- `mcp-server.log` — MCP server tool calls
- `mcp-health.log` — SessionStart MCP sample + SubagentStop hook diagnostics
- `issue-sync.log` — `issue_sync_active` warnings + sync errors
- `sql.log` — SQL trace (when enabled)
- `<project>/.claude/tmb/l5-trajectories/<flow>/<run_id>/` — trajectory.jsonl + trajectory.db preserved per flow run (written by `l5_preserve_trajectory` in flow-helpers.sh)
- `<project>/.claude/tmb/l6-chain-runs/<run-id>/` — L6 chain runs (`tests/l5-l6/run-l6-chain.sh`; `L6C_RUNS_DIR` overrides)

## Env vars

- `TMB_DISABLE_REMOTE_SYNC=1` — overrides `issue_sync` config to off (defense-in-depth)
- `TRAJECTORY_DB_PATH` — pin DB path for tests/CI (step 1 of [the DB location rule](./TRAJECTORY_DB_LOCATION.md))
- `CLAUDE_PLUGIN_ROOT` — set by CC; resolves plugin name for path calculations

## Hooks (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PermissionDenied / Stop / SubagentStop / WorktreeCreate)

59 hook scripts under `scripts/hooks/`, wired via `hooks/hooks.json`, plus gates born in TypeScript (a `.ts` row: `mcp/trajectory-server/src/hooks/<name>.ts`, no `.sh`; `dispatch.sh` runs it through `node dist/hooks.js` when `dist/hooks-gates.txt` lists it). The eight PreToolUse-Agent gates run through a single `agent-spawn-dispatch.sh` dispatcher rather than as separate registrations. The trajectory-server gates are one registration, `dispatch.sh trajectory-gates`: `agent-arg-matches-caller.sh`, `swe-brief-gate.sh`, then the tool's own gate, in that order, stopping at the first deny.

| Hook | Trigger | Purpose |
|---|---|---|
| `ensure-gitignore.sh` | SessionStart | Project .gitignore must exclude .claude/ |
| `mcp-health-check.sh` | SessionStart | MCP server presence sample (soft note, never HALT) + install-scope and duplicate-copy notices |
| `deferred-tools-drift-warn.sh` | SessionStart | Warn when MCP tools on disk newer than running server |
| `plugin-hooks-marker.sh` | SessionStart | Mark the session as running the plugin's hooks (`<project>/.claude/tmb/sessions/<id>.plugin-hooks`) so the opt-in headless shim yields |
| `session-start-persona.sh` | SessionStart | Inject bro's persona (the plugin's `CLAUDE.md`) on every source, plus a one-line note when the project's `CLAUDE.md` holds an old tmb persona block; mark the session (`<project>/.claude/tmb/sessions/<id>.persona`); silent when the project is the plugin root |
| `session-start-prescan.sh` | SessionStart | Inject project inventory (git state, stacks, world-model warmth), plus a line for duplicate enabled copies or pre-1.1.0 hooks left in `~/.claude/settings.json` |
| `ensure-mcp-deps-installed.sh` | SessionStart | Lazy-install the MCP server's `@huggingface/transformers` in the background when the pinned version does not resolve from `mcp/trajectory-server`: once per data dir, pruned, into `$CLAUDE_PLUGIN_DATA/deps/<version>-<platform>-<arch>/` from `mcp/trajectory-server/runtime-deps/` (no lifecycle scripts), bridged into each plugin version by a `node_modules/@huggingface/transformers` symlink; without `CLAUDE_PLUGIN_DATA` or on Windows, into the plugin as before. Embeddings go live on the next restart. Runs from TypeScript (`src/hooks/ensure-mcp-deps-installed.ts`) |
| `substrate-preflight.sh` | SessionStart | Verify the trajectory DB + world-model substrates are reachable before the session proceeds |
| `orphan-scan.sh` | SessionStart | Report this project's stale trajectory DBs, duplicate server procs and unpinned caches left by upgrades (cleans only when opted in) |
| `user-prompt-persona.sh` | UserPromptSubmit | Inject bro's persona once in a session with no persona marker (plugin hooks reloaded mid-session) and mark it; a one-time notice to start a new session when the plugin's `CLAUDE.md` cannot be read |
| `rework-waiver-capture.ts` | UserPromptSubmit | The one writer of `author='human'` discussions rows: for each `waive task <N>` in the Human's prompt (case-insensitive, optional `#`), write a `decision` row on task N and its issue whose body is the prompt line (500 characters at most). Other wording, an unknown task, a harness turn or no DB writes nothing; never blocks |
| `activation-routine.sh` | UserPromptSubmit | Pre-fetch onboarded marker + pending issue for bro banner; HALT + recovery pointer when the MCP server is not running |
| `session-log-capture.sh` | UserPromptSubmit | Track current cc.log for diagnostics |
| `prompt-intent-hints.sh` | UserPromptSubmit | Route intent phrases (concerns / push / resume / reonboard / headless / ADR / consultant / search-grounding) to the right guidance; `headless-intent` asks one consent before enabling headless enforcement |
| `roundtable-slash-detect.sh` | UserPromptSubmit | Detect `/roundtable` invocation for server gate |
| `swe-resume-gate.ts` | PreToolUse SendMessage | Judge a message to a swe (an agent id that is the `spawn_id` of an agent_runs swe row) as a resume of its task: deny it at the rework limit with `rework-limit`'s reason, and deny it when the swe's latest run has an effort other than the task's current one, naming a fresh spawn at the task's effort. Other targets and a swe of a closed task pass with no output; a DB read failure denies |
| `task-overrun-alert.ts` | UserPromptSubmit + PostToolUse trajectory-server | Tell bro, once per task, that a `running` task passed `TMB_TASK_OVERRUN_MIN` minutes (default 60) since `created_at`: minutes, swe spawns and the blocker (the latest FAIL's first line, else the status); the `task_overrun_alerted` audit row is the once-marker. Bro only, never denies |
| `git-guards.sh` | PreToolUse Bash | Catches reset --hard / clean -fd / force-pushes to main |
| `git-push-guard.sh` | PreToolUse Bash | SWE can't push; push requires passing validation_attempts |
| `swe-boundary.sh` | PreToolUse Bash + Edit/Write | Keep SWE inside its worktree and assigned scope |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Bro creates branches; SWE can't `git worktree -b` |
| `stay-on-base-guard.sh` | PreToolUse Bash | Block code edits / commits while sitting on the base branch |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Block worktree create if branch behind origin |
| `commit-msg-lint.sh` | PreToolUse Bash | Enforce conventional-commit subject format |
| `no-remote-auth-guard.sh` | PreToolUse Bash | Block interactive remote-auth flows (gh/glab login) |
| `remote-id-guard.sh` | PreToolUse Bash | Guard remote-identity / repo-creation operations |
| `agent-spawn-dispatch.sh` | PreToolUse Agent | Dispatcher for the spawn gates: `require-task-spec.sh`, `require-spawn-effort.sh`, `require-feature-branch-active.sh`, `code-reviewer-no-worktree.sh`, `code-reviewer-spawn-prompt-shape.sh`, `code-reviewer-after-atomic-close.sh`, then the TypeScript gates `code-reviewer-spawn-note` (deny a code-reviewer prompt carrying more than 300 characters of prose beyond its anchors; that context goes in `spawn_note` via `bro_atomic_close`), `code-reviewer-preflight` (the task commit's deterministic checks) and `rework-limit` (deny a swe spawn at two review FAILs on the task since its last pass, six swe runs of it minus budget handbacks, or four FAILs across its issue's tasks, each counted since the latest Human row on the task or issue; only the Human's `waive task <N>` lifts it), then prepares the worktree via `ensure-swe-worktree.sh` and records the swe spawn via `record-swe-spawn.sh` (task → running, one open `agent_runs` row) |
| `agent-arg-matches-caller.sh` | PreToolUse trajectory-server | Deny a call whose `agent` argument names another role than the caller (the payload's `agent_type`, or bro for the main session) and audit `agent_arg_mismatch`; a missing `agent` is allowed and the decision never depends on the trajectory DB |
| `swe-brief-gate.sh` | PreToolUse trajectory-server + Edit/Write | SWE must have fetched its task brief (`task_brief` records the `swe_brief_fetched` sentinel; the hook reads it) before touching state or files |
| `swe-verification-gate.sh` | PreToolUse trajectory-server (task_update_status) | Gate the SWE close transition on verification |
| `reviewer-identity-observe.sh` | PreToolUse trajectory-server (validation_record) | Record the calling code-reviewer's `session_id`, `agent_id` and `tool_use_id` with `observed_at` (`reviewer_identity_observed`) so `validation_record` stamps the reviewer's identity; observe-only, fails closed only when the trajectory DB is unavailable |
| `cheatcode-install-approval.sh` | PreToolUse trajectory-server (cheatcode_install) | Require Human approval before installing a cheatcode |
| `askuserquestion-length-lint.sh` | PreToolUse AskUserQuestion | Cap label/description lengths |
| `roundtable-auq-shape.sh` | PreToolUse AskUserQuestion | Validate AUQ shape during roundtable awaiting_human |
| `no-source-edit-from-main.sh` | PreToolUse Edit/Write | Bro can't edit source from main checkout |
| `containment-guard.sh` | PreToolUse Write/Edit/MultiEdit/NotebookEdit/Bash | Deny a write outside the run's root — the swe's task worktree (`agent_runs.root_dir`), else the project |
| `swe-scope-fence.sh` | PreToolUse Edit/Write | Note (never deny) an SWE edit outside the task's `files[]`, once per path; scope is judged at close by `bro_atomic_close` |
| `naming-lint.sh` | PreToolUse Edit/Write | Enforce kebab/snake/Pascal naming conventions per language |
| `code-quality-lint.sh` | PreToolUse Edit/Write | Catch mechanical quality patterns (bare except, mutable defaults, etc.) |
| `debug-trajectory.sh` | PreToolUse (all, debug-mode) | Persist trajectory rows when TMB_DEBUG_TRAJECTORY=1 |
| `cleanup-worktree-on-task-close.sh` | PostToolUse task_update_status + validation_record | Remove worktree on a `task_update_status` close or a passing review of the closed task |
| `roundtable-cleanup-postcheck.sh` | PostToolUse roundtable_close | Verify capture surface on close |
| `post-task-close-rescan.sh` | PostToolUse bro_atomic_close | Background /scan to refresh the world model after close |
| `post-atomic-close-readme.sh` | PostToolUse bro_atomic_close | Refresh directory README summaries after close |
| `post-task-create-spawn-hint.sh` | PostToolUse task-create (batch insert path) | Remind bro to spawn SWE after a task is provisioned |
| `attribution-footer.sh` | PostToolUse Bash | Append co-author / session attribution to commits |
| `clean-merged-branch.sh` | PostToolUse Bash | Prune local branches once their PR merges |
| `close-issue-on-merge.sh` | PostToolUse Bash | Close the local issue when its PR merges |
| `swe-spawn-bind.sh` | PostToolUse Agent | Bind an accepted swe spawn's `tool_use:<tool_use_id>` run row to `tool_response.agentId` |
| `swe-spawn-rollback.sh` | PermissionDenied Agent | Roll back a swe spawn auto mode refused: close its `tool_use:<tool_use_id>` run row as `swept_orphan` and, with no other swe run open, return the task to `pending` |
| `bro-turn-usage.sh` | Stop | Meter bro's token usage into one `agent_runs` row per session |
| `swe-atomic-close.sh` | SubagentStop | Auto-close a pending or running SWE task that committed; capture swe and code-reviewer agent_runs metrics and effort |
| `consultant-persistence-gate.sh` | SubagentStop | Persist a consultant subagent's output before it exits |
| `worktree-create.sh` | WorktreeCreate | Enforce worktree-creation rules |

## Schema state — see [ERD.md](../architecture/ERD.md) for the full table list
