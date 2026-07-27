# Reference pointers

Lookups bro hits occasionally — keep here so they don't bloat CLAUDE.md.

## Where state lives

- **Trajectory DB** — SQLite at `<project>/.claude/<plugin-name>/trajectory.db`. Holds the workflow audit: issues, tasks, discussions, audit, validation, plugin metadata. The `<plugin-name>` segment resolves from `CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json`'s `name` field; today that's `tmb` for both stable and RC channels, so both write to `.claude/tmb/`. Project-local, gitignored, per-developer.
- **World model graph DB** — kuzu at `<project>/.claude/<plugin-name>/world-model.kuzu/` for the standard `trajectory.db`. A custom `TRAJECTORY_DB_PATH` maps to `<db-basename>.world-model.kuzu`; graph-shaped trajectory filenames are reserved. Holds bro's project mental picture: Directory nodes + CONTAINS edges (more node/edge types in follow-up slices). See `docs/architecture/WORLD_MODEL.md`.
- **Task specs** — `tasks.spec_body` column, fetched via `task_get(task_id)`. NOT on disk.
- **Issue milestone** — `issues.milestone` column (nullable `TEXT`), a composite FK `(milestone, repo)` into the per-repo `milestones` table (#155, schema v23). See `docs/architecture/ERD.md`.
- **Architectural decisions** — recorded as `kind=decision` discussions in the trajectory DB.
- **Snapshots** — `docs/trustmybot/snapshots/<issue_id>.md`, generated via `issue_snapshot_md`.

## Other docs

- **Prompt-engineering guide (authoring agent prompts)** — [`PROMPT_ENGINEERING.md`](../prompt-engineering/PROMPT_ENGINEERING.md)
- **Agent layer model + override rules** — [`architecture/RESPONSIBILITIES.md`](../architecture/RESPONSIBILITIES.md)
- **plugin_config keys** — `mcp/trajectory-server/docs/CONFIG_KEYS.md`
- **Full architecture** — `docs/architecture/FLOWS.md`

## MCP tools (full list)

67 tools across these groups (full schema in `mcp/trajectory-server/src/tools/`):

- **issues**: `issue_create`, `issue_get`, `issue_list`, `issue_close`, `issue_link`, `issue_update_description`, `issue_resume`, `issue_get_phase`, `issue_sync_retry`
- **tasks**: `task_get`, `task_update_status`, `task_first_actionable`
- **stats**: `task_stats`
- **discussions**: `discussion_append` (verified_human gate when author='human'), `discussion_list`, `discussion_search`, `issue_get_with_discussions`
- **roundtable**: `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_close_with_decisions`, `roundtable_finalize_decisions`, `roundtable_summarize` (state machine: collecting → awaiting_human → closed | skipped)
- **pr_monitor**: `pr_monitor_comments_get` (gh + glab backends; bot detection via DEFAULT_BOT_PATTERNS), `pr_monitor_runs_list`
- **validation**: `validation_record` (subagent_session_id required when agent='pr-reviewer'), `validation_history`
- **world model** (bro's directory-level memory): `world_model_get` (annotated dir tree), `world_model_search` (keyword / semantic / hybrid)
- **onboard**: `onboard_state_get`, `onboard_get_questions`, `onboard_apply`
- **config**: `config_get`, `config_list`, `config_set`
- **scan**: `scan_run`, `repos_list`
- **reports**: `issue_report_md`, `issue_snapshot_md`, `branch_report_md`
- **cheatcodes** (unified skill/agent registry): `cheatcode_list`, `cheatcode_search`, `cheatcode_install`, `cheatcode_activate`, `cheatcode_approve`, `cheatcode_vet`, `cheatcode_uninstall`
- **skills** (builtin rows in the `cheatcodes` registry): `skill_register`, `skill_promote`
- **agents**: `agent_list`, `agent_register`, `agent_resolve`
- **composites**: `intent_start`, `branch_id_propose`, `task_provision`, `task_brief`, `task_retry`, `task_recover`, `bro_atomic_close`, `bro_verification_fail_record`, `pr_monitor_worktree`, `worktree_commits_fetch`
- **audit**: `audit_append`, `audit_list`, `audit_search`

## Slash commands

- `/roundtable <topic>` — multi-agent deliberation with checkbox/radio AUQ ratification (full procedure in `commands/roundtable.md`)
- `/onboard` — interactive policy ceremony with two branches based on project shape (local-only vs remote-tracked). Auto-fired on first contact when `plugin_config('onboarded')` is unset; Human-typed for later changes (full procedure in `commands/onboard.md`)
- `/monitor <PR_number>` — invokes `tmb_comment-triage` skill: fetches review comments, plans tasks, dispatches SWE per ratified comment
- `/scan` — triggers `scan_run` to rebuild the world model graph (directory nodes + CONTAINS edges in kuzu) and refresh the repos registry
- `/tmb:agent-create <role> <question>` — spawns a consultant subagent with the given domain role and seed question

Runtime location: `plugin/commands/<name>.md`.

## Logs

- `~/.claude/tmb/logs/cc.log` — CC session log (rotated to .log.1)
- `~/.claude/tmb/logs/mcp-server.log` — MCP server tool calls
- `~/.claude/tmb/logs/mcp-health.log` — MCP health check + hook diagnostics
- `~/.claude/tmb/logs/issue-sync.log` — `issue_sync_active` warnings + sync errors
- `~/.claude/tmb/logs/sql.log` — SQL trace (when enabled)
- `~/.claude/tmb/l5-trajectories/<flow>/<run_id>/` — trajectory.jsonl + trajectory.db preserved per flow run (written by `l5_preserve_trajectory` in flow-helpers.sh)

## Env vars

- `TMB_DISABLE_REMOTE_SYNC=1` — overrides `issue_sync` config to off (defense-in-depth)
- `TRAJECTORY_DB_PATH` — pin DB path for tests/CI (overrides walk-up resolution)
- `CLAUDE_PLUGIN_ROOT` — set by CC; resolves plugin name for path calculations

## Hooks (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStop / WorktreeCreate)

52 hook scripts under `scripts/hooks/`, wired via `hooks/hooks.json`. The six PreToolUse-Agent gates run through a single `agent-spawn-dispatch.sh` dispatcher rather than as separate registrations.

| Hook | Trigger | Purpose |
|---|---|---|
| `ensure-gitignore.sh` | SessionStart | Project .gitignore must exclude .claude/ |
| `mcp-health-check.sh` | SessionStart + UserPromptSubmit (periodic) | MCP server liveness probe |
| `deferred-tools-drift-warn.sh` | SessionStart | Warn when MCP tools on disk newer than running server |
| `write-active-workspace-sentinel.sh` | SessionStart | Sentinel for cross-session workspace resolution |
| `session-start-prescan.sh` | SessionStart | Inject project inventory (git state, stacks, world-model warmth) |
| `ensure-kuzu-installed.sh` | SessionStart | Lazy-install kuzu native binary for the world-model graph DB (first session after plugin install/update) |
| `substrate-preflight.sh` | SessionStart | Verify the trajectory DB + world-model substrates are reachable before the session proceeds |
| `cheatcode-healthcheck.sh` | SessionStart | Check the cheatcodes registry is consistent on boot |
| `activation-routine.sh` | UserPromptSubmit | Pre-fetch onboarded marker + pending issue for bro banner |
| `session-log-capture.sh` | UserPromptSubmit | Track current cc.log for diagnostics |
| `prompt-intent-hints.sh` | UserPromptSubmit | Route intent phrases (concerns / push / resume / reonboard / ADR / consultant / search-grounding) to the right guidance |
| `roundtable-slash-detect.sh` | UserPromptSubmit | Detect `/roundtable` invocation for server gate |
| `git-guards.sh` | PreToolUse Bash | Catches reset --hard / clean -fd / force-pushes to main |
| `git-push-guard.sh` | PreToolUse Bash | SWE can't push; push requires passing validation_attempts |
| `swe-boundary.sh` | PreToolUse Bash + Edit/Write | Keep SWE inside its worktree and assigned scope |
| `no-worktree-branch-create.sh` | PreToolUse Bash | Bro creates branches; SWE can't `git worktree -b` |
| `stay-on-base-guard.sh` | PreToolUse Bash | Block code edits / commits while sitting on the base branch |
| `branch-up-to-date-with-remote.sh` | PreToolUse Bash | Block worktree create if branch behind origin |
| `commit-msg-lint.sh` | PreToolUse Bash | Enforce conventional-commit subject format |
| `no-remote-auth-guard.sh` | PreToolUse Bash | Block interactive remote-auth flows (gh/glab login) |
| `remote-id-guard.sh` | PreToolUse Bash | Guard remote-identity / repo-creation operations |
| `agent-spawn-dispatch.sh` | PreToolUse Agent | Dispatcher for the spawn gates: `require-task-spec.sh`, `require-feature-branch-active.sh`, `pr-reviewer-no-worktree.sh`, `pr-reviewer-spawn-prompt-shape.sh`, `pr-reviewer-after-atomic-close.sh`, then prepares the worktree via `ensure-swe-worktree.sh` |
| `swe-brief-gate.sh` | PreToolUse trajectory-server + Edit/Write | SWE must have fetched its task brief before touching state or files |
| `swe-verification-gate.sh` | PreToolUse task_update_status | Gate the SWE close transition on verification |
| `cheatcode-install-approval.sh` | PreToolUse cheatcode_install | Require Human approval before installing a cheatcode |
| `askuserquestion-length-lint.sh` | PreToolUse AskUserQuestion | Cap label/description lengths |
| `roundtable-auq-shape.sh` | PreToolUse AskUserQuestion | Validate AUQ shape during roundtable awaiting_human |
| `no-source-edit-from-main.sh` | PreToolUse Edit/Write | Bro can't edit source from main checkout |
| `swe-scope-fence.sh` | PreToolUse Edit/Write | Confine SWE edits to the task's declared `files[]` scope |
| `naming-lint.sh` | PreToolUse Edit/Write | Enforce kebab/snake/Pascal naming conventions per language |
| `code-quality-lint.sh` | PreToolUse Edit/Write | Catch mechanical quality patterns (bare except, mutable defaults, etc.) |
| `debug-trajectory.sh` | PreToolUse (all, debug-mode) | Persist trajectory rows when TMB_DEBUG_TRAJECTORY=1 |
| `cleanup-worktree-on-task-close.sh` | PostToolUse task_update_status + bro_atomic_close | Remove worktree on close |
| `roundtable-cleanup-postcheck.sh` | PostToolUse roundtable_close | Verify capture surface on close |
| `post-task-close-rescan.sh` | PostToolUse bro_atomic_close | Background /scan to refresh the world model after close |
| `post-atomic-close-readme.sh` | PostToolUse bro_atomic_close | Refresh directory README summaries after close |
| `post-task-create-spawn-hint.sh` | PostToolUse task-create (batch insert path) | Remind bro to spawn SWE after a task is provisioned |
| `post-pr-comments-persist.sh` | PostToolUse pr_monitor_comments_get | Auto-persist returned PR comments as discussion rows |
| `attribution-footer.sh` | PostToolUse Bash | Append co-author / session attribution to commits |
| `clean-merged-branch.sh` | PostToolUse Bash | Prune local branches once their PR merges |
| `close-issue-on-merge.sh` | PostToolUse Bash | Close the local issue when its PR merges |
| `bro-turn-usage.sh` | Stop | Capture bro's per-turn token/cost usage |
| `swe-atomic-close.sh` | SubagentStop | Auto-close pending SWE task; capture agent_runs metrics |
| `consultant-persistence-gate.sh` | SubagentStop | Persist a consultant subagent's output before it exits |
| `worktree-create.sh` | WorktreeCreate | Enforce worktree-creation rules |

## Schema state — see ERD.md for full table list (schema v28)
