# Reference pointers

Lookups bro hits occasionally — keep here so they don't bloat CLAUDE.md.

## Where state lives

- **Trajectory DB** — SQLite at `<project>/.claude/<plugin-name>/trajectory.db`. The `<plugin-name>` segment matches `plugin.json.name`, so the stable channel writes to `.claude/tmb/` and the RC channel writes to `.claude/tmb-rc/` — full filesystem isolation when both are installed (#87). Project-local, gitignored, per-developer.
- **Task specs** — `tasks.spec_body` column, fetched via `task_get(task_id)`. NOT on disk.
- **ADRs** — `docs/trustmybot/architecture/manual/decisions/N-*.md`, hand-curated.
- **Auto-rendered architecture docs** — `docs/trustmybot/architecture/auto/`, refreshed by the scan-side renderer pass (currently inert; see #2881 follow-up).
- **Snapshots** — `docs/trustmybot/snapshots/<issue_id>.md`, generated via `issue_snapshot_md`.

## Other docs

- **Agent layer model + override rules** — [`AGENTS.md`](AGENTS.md)
- **Benchmark results vs Sonnet 4 + Opus 4** — [`BENCHMARK.md`](BENCHMARK.md)
- **Performance budgets** — `CONTRIBUTING.md` → Performance section
- **plugin_config keys** — `mcp/trajectory-server/docs/CONFIG_KEYS.md`
- **Full architecture** — `docs/architecture/FLOWS.md`

## MCP tools (full list)

50+ tools across these groups (full schema in `mcp/trajectory-server/src/tools/`):

- **issues**: `issue_create`, `issue_get`, `issue_list`, `issue_close`, `issue_update_description`, `issue_resume`, `issue_get_phase`, `issue_sync_retry`, `issue_report_md`, `issue_snapshot_md`, `issue_add_labels`, `issue_remove_labels`, `issue_set_labels`
- **tasks**: `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable`, `task_stats`
- **discussions**: `discussion_append` (verified_human gate when author='human'), `discussion_list`, `issue_get_with_discussions`
- **roundtable**: `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_finalize_decisions`, `roundtable_summarize` (state machine: collecting → awaiting_human → closed | skipped)
- **pr_comments**: `pr_comments_get` (gh + glab backends; bot detection via DEFAULT_BOT_PATTERNS)
- **validation**: `validation_record` (subagent_session_id required when agent='pr-reviewer'), `validation_history`
- **file_registry**: `file_registry_upsert`, `file_registry_update_summaries` (bro-only; close-gate-enforced), `file_registry_list`, `file_registry_verify`, `file_registry_delete`
- **onboard**: `onboard_state_get`, `onboard_get_questions`, `onboard_apply` (replaced the legacy identity surface per #2876)
- **config**: `config_get`, `config_list`, `config_set`
- **scan**: `scan_run`, `repos_list`, `file_registry_bulk_upsert` (replaced the legacy standalone arch-refresh surface per #2881)
- **reports**: `issue_report_md`, `issue_snapshot_md`, `branch_report_md`
- **skills**: `skill_register`, `skill_promote`, `skill_record_outcome`
- **audit**: `audit_log`, `audit_log_list`

## Slash commands

- `/roundtable <topic>` — multi-agent deliberation with checkbox/radio AUQ ratification (full procedure in `commands/roundtable.md`)
- `/onboard` — interactive policy ceremony with two branches based on project shape (local-only vs remote-tracked). Auto-fired on first contact when `plugin_config('onboarded')` is unset; Human-typed for later changes (full procedure in `commands/onboard.md`)
- `/monitor <PR_number>` — invokes `tmb_review` skill (PR comment triage section): fetches review comments, plans tasks, dispatches SWE per ratified comment

Catalog: `docs/commands/README.md`.

## Logs

- `~/.claude/tmb/logs/cc.log` — CC session log (rotated to .log.1)
- `~/.claude/tmb/logs/mcp-server.log` — MCP server tool calls
- `~/.claude/tmb/logs/mcp-health.log` — MCP health check + hook diagnostics
- `~/.claude/tmb/logs/issue-sync.log` — `issue_sync_active` warnings + sync errors (#132, #147)
- `~/.claude/tmb/logs/sql.log` — SQL trace (when enabled)
- `~/.claude/tmb/l5-trajectories/<flow>/<run_id>/` — trajectory.jsonl + trajectory.db preserved per flow run (written by `l5_preserve_trajectory` in flow-helpers.sh)

## Env vars

- `TMB_HEADLESS=1` — disables AskUserQuestion; bro halts per `tmb_recovery` §A
- `TMB_DISABLE_REMOTE_SYNC=1` — overrides `issue_sync` config to off (defense-in-depth, #146)
- `TRAJECTORY_DB_PATH` — pin DB path for tests/CI (overrides walk-up resolution)
- `CLAUDE_PLUGIN_ROOT` — set by CC; resolves plugin name for path calculations

## Hooks (PreToolUse / PostToolUse / SessionStart / Stop / SubagentStop / UserPromptSubmit / WorktreeCreate)

22 hooks under `scripts/hooks/`:

| Hook | Trigger | Purpose |
|---|---|---|
| `activation-routine.sh` | UserPromptSubmit | Pre-fetch identity + pending issue for bro banner |
| `no-source-edit-from-main.sh` | PreToolUse Edit/Write | Bro can't edit source from main checkout |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Bro creates branches; SWE can't `git worktree -b` |
| `git-push-guard.sh` | PreToolUse Bash | SWE can't push; force-push blocked |
| `git-guards.sh` | PreToolUse Bash | Catches reset --hard / clean -fd / force-pushes to main |
| `swe-atomic-close.sh` | SubagentStop | Auto-close pending SWE task; capture agent_runs metrics |
| `cleanup-worktree-on-task-close.sh` | PostToolUse task_update_status | Remove worktree on close |
| `require-summaries-before-task-close.sh` | PreToolUse task_update_status | Block close if file_registry summaries stale |
| `require-task-spec.sh` | PreToolUse Task | SWE spawn requires task_id + worktree |
| `roundtable-auq-shape.sh` | PreToolUse AskUserQuestion | Validate AUQ shape during roundtable awaiting_human (#141) |
| `ensure-gitignore.sh` | SessionStart | Project .gitignore must exclude .claude/ |
| `session-log-capture.sh` | SessionStart | Track current cc.log for diagnostics |
| `write-active-workspace-sentinel.sh` | SessionStart | Sentinel for cross-session workspace resolution |
| `mcp-health-check.sh` | UserPromptSubmit (periodic) | MCP server liveness probe |
| `askuserquestion-length-lint.sh` | PreToolUse AskUserQuestion | Cap label/description lengths |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Block worktree create if branch behind origin |
| `worktree-create.sh` | WorktreeCreate | Worktree-creation rules |
| `deferred-tools-drift-warn.sh` | SessionStart | Warn when MCP tools on disk newer than running server |
| `debug-trajectory.sh` | PreToolUse (debug-mode hook) | Persist trajectory rows when debug enabled |
| `diagnostic` | (diagnostic dir) | Misc diagnostic helpers |

## Schema state — see ERD.md for full table list (18 tables, post-#142)
