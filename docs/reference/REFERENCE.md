# Reference pointers

Lookups bro hits occasionally — keep here so they don't bloat CLAUDE.md.

## Where state lives

- **Trajectory DB** — SQLite at `<project>/.claude/<plugin-name>/trajectory.db`. Holds the workflow audit: issues, tasks, discussions, audit, validation, plugin metadata. The `<plugin-name>` segment resolves from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`'s `name` field; today that's `tmb` for both stable and RC channels, so both write to `.claude/tmb/`. Project-local, gitignored, per-developer.
- **World model graph DB** — kuzu at `<project>/.claude/<plugin-name>/world-model.kuzu/`. Holds bro's project mental picture: Directory nodes + CONTAINS edges (more node/edge types in follow-up slices). Sibling file to the trajectory DB. See `docs/architecture/WORLD_MODEL.md`.
- **Task specs** — `tasks.spec_body` column, fetched via `task_get(task_id)`. NOT on disk.
- **ADRs** — `docs/trustmybot/architecture/manual/decisions/N-*.md`, hand-curated.
- **Snapshots** — `docs/trustmybot/snapshots/<issue_id>.md`, generated via `issue_snapshot_md`.

## Other docs

- **Prompt-engineering guide (authoring agent prompts)** — [`PROMPT_ENGINEERING.md`](../prompt-engineering/PROMPT_ENGINEERING.md)
- **Agent layer model + override rules** — [`architecture/RESPONSIBILITIES.md`](../architecture/RESPONSIBILITIES.md)
- **Benchmark results vs Sonnet 4 + Opus 4** — [`BENCHMARK.md`](../contributing/BENCHMARK.md)
- **Performance budgets** — `CONTRIBUTING.md` → Performance section
- **plugin_config keys** — `mcp/trajectory-server/docs/CONFIG_KEYS.md`
- **Full architecture** — `docs/architecture/FLOWS.md`

## MCP tools (full list)

60 tools across these groups (full schema in `mcp/trajectory-server/src/tools/`):

- **issues**: `issue_create`, `issue_get`, `issue_list`, `issue_close`, `issue_update_description`, `issue_resume`, `issue_get_phase`, `issue_sync_retry`, `issue_report_md`, `issue_snapshot_md`
- **tasks**: `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable`, `task_stats`
- **discussions**: `discussion_append` (verified_human gate when author='human'), `discussion_list`, `issue_get_with_discussions`
- **roundtable**: `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_finalize_decisions`, `roundtable_summarize` (state machine: collecting → awaiting_human → closed | skipped)
- **pr_comments**: `pr_comments_get` (gh + glab backends; bot detection via DEFAULT_BOT_PATTERNS), `pr_review_runs_list`
- **validation**: `validation_record` (subagent_session_id required when agent='pr-reviewer'), `validation_history`
- **world model** (bro's directory-level memory): `world_model_get` (annotated dir tree), `world_model_search` (keyword / semantic / hybrid)
- **onboard**: `onboard_state_get`, `onboard_get_questions`, `onboard_apply`
- **config**: `config_get`, `config_list`, `config_set`
- **scan**: `scan_run`, `repos_list`
- **reports**: `issue_report_md`, `issue_snapshot_md`, `branch_report_md`
- **skills**: `skill_register`, `skill_promote`, `skill_record_outcome`, `skill_record_invocation`, `skill_invocations_list`
- **rules**: `rule_register`, `rule_list`, `rule_record_invocation`, `rule_invocations_list`
- **commands**: `command_register`, `command_list`
- **agents**: `agent_list`, `agent_register`
- **composites**: `branch_id_propose`, `task_retry_batch`, `bro_atomic_close`
- **audit**: `audit_log`, `audit_log_list`

## Slash commands

- `/roundtable <topic>` — multi-agent deliberation with checkbox/radio AUQ ratification (full procedure in `commands/roundtable.md`)
- `/onboard` — interactive policy ceremony with two branches based on project shape (local-only vs remote-tracked). Auto-fired on first contact when `plugin_config('onboarded')` is unset; Human-typed for later changes (full procedure in `commands/onboard.md`)
- `/monitor <PR_number>` — invokes `tmb_review` skill (PR comment triage section): fetches review comments, plans tasks, dispatches SWE per ratified comment

Runtime location: `plugin/commands/<name>.md`.

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

## Hooks (PreToolUse / PostToolUse / SessionStart / SubagentStop / UserPromptSubmit / WorktreeCreate)

39 hooks under `scripts/hooks/`:

| Hook | Trigger | Purpose |
|---|---|---|
| `ensure-gitignore.sh` | SessionStart | Project .gitignore must exclude .claude/ |
| `ensure-kuzu-installed.sh` | SessionStart | Lazy-install kuzu native binary for the world-model graph DB (first session after plugin install/update) |
| `mcp-health-check.sh` | SessionStart + UserPromptSubmit (periodic) | MCP server liveness probe |
| `deferred-tools-drift-warn.sh` | SessionStart | Warn when MCP tools on disk newer than running server |
| `write-active-workspace-sentinel.sh` | SessionStart | Sentinel for cross-session workspace resolution |
| `session-start-prescan.sh` | SessionStart | Inject project inventory (git state, stacks, world-model warmth) |
| `activation-routine.sh` | UserPromptSubmit | Pre-fetch onboarded marker + pending issue for bro banner |
| `session-log-capture.sh` | UserPromptSubmit | Track current cc.log for diagnostics |
| `consultant-spawn-required.sh` | UserPromptSubmit | Inject domain-expert prompt → suggest consultant spawn |
| `roundtable-slash-detect.sh` | UserPromptSubmit | Detect `/roundtable` invocation for server gate |
| `concerns-protocol-hint.sh` | UserPromptSubmit | Surface concerns-protocol guidance when concern raised |
| `push-intent-hint.sh` | UserPromptSubmit | Inject push-gate guidance on push intent |
| `reonboard-intent-hint.sh` | UserPromptSubmit | Route reonboard phrases to /onboard |
| `resume-intent-hint.sh` | UserPromptSubmit | Surface pending issue on resume intent |
| `adr-required-hint.sh` | UserPromptSubmit | Inject ADR hint on architectural changes |
| `git-guards.sh` | PreToolUse Bash | Catches reset --hard / clean -fd / force-pushes to main |
| `git-push-guard.sh` | PreToolUse Bash | SWE can't push; push requires passing validation_attempts |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Bro creates branches; SWE can't `git worktree -b` |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Block worktree create if branch behind origin |
| `commit-msg-lint.sh` | PreToolUse Bash | Enforce conventional-commit subject format |
| `require-task-spec.sh` | PreToolUse Agent | SWE spawn requires task_id + non-empty spec |
| `require-feature-branch-active.sh` | PreToolUse Agent | Block issue/task ops without a feature branch |
| `pr-reviewer-no-worktree.sh` | PreToolUse Agent | Prevent pr-reviewer from creating worktrees |
| `askuserquestion-length-lint.sh` | PreToolUse AskUserQuestion | Cap label/description lengths |
| `roundtable-auq-shape.sh` | PreToolUse AskUserQuestion | Validate AUQ shape during roundtable awaiting_human |
| `auq-headless-deny.sh` | PreToolUse AskUserQuestion | Deny AUQ when TMB_HEADLESS=1 |
| `no-source-edit-from-main.sh` | PreToolUse Edit/Write | Bro can't edit source from main checkout |
| `naming-lint.sh` | PreToolUse Edit/Write | Enforce kebab/snake/Pascal naming conventions per language |
| `code-quality-lint.sh` | PreToolUse Edit/Write | Catch mechanical quality patterns (bare except, mutable defaults, etc.) |
| `debug-trajectory.sh` | PreToolUse (all, debug-mode) | Persist trajectory rows when TMB_DEBUG_TRAJECTORY=1 |
| `cleanup-worktree-on-task-close.sh` | PostToolUse task_update_status | Remove worktree on close |
| `roundtable-cleanup-postcheck.sh` | PostToolUse roundtable_close | Verify capture surface on close |
| `post-task-close-rescan.sh` | PostToolUse bro_atomic_close | Background /scan to refresh the world model after close |
| `post-task-create-spawn-hint.sh` | PostToolUse task_create_batch | Remind bro to spawn SWE after task batch |
| `skill-invocation-record.sh` | PostToolUse Skill | Record skill invocation in trajectory DB |
| `swe-atomic-close.sh` | SubagentStop | Auto-close pending SWE task; capture agent_runs metrics |
| `worktree-create.sh` | WorktreeCreate | Enforce worktree-creation rules |

## Schema state — see ERD.md for full table list (schema v8)
