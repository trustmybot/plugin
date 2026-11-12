# Reference pointers

A contributor's lookup: where TMB keeps its state, and the names of its MCP tools, slash commands, logs, environment variables and hooks. Each entry points at the code or doc that holds the detail.

## Where state lives

- **Trajectory DB** — SQLite at `<project>/.claude/tmb/trajectory.db`, the same path on every channel; project-local, git-ignored, one per developer. It holds the workflow audit: issues, tasks, discussions, audit rows, validation and plugin metadata. [TRAJECTORY_DB_LOCATION.md](./TRAJECTORY_DB_LOCATION.md) has the rule that picks the file.
- **World model** — tables in the same DB holding directories with summaries, files with a one-line purpose, and a symbol index with calls and imports, rebuilt by `/scan`. See [WORLD_MODEL.md](../architecture/WORLD_MODEL.md).
- **Task specs** — the prose spec plus typed scope (`files`) and verification fields that the gates enforce, all in the DB and fetched with `task_get`; never on disk.
- **Issue milestones** — a per-repo milestone on each issue. See [ERD.md](../architecture/ERD.md).
- **Architectural decisions** — `kind=decision` discussions in the DB.
- **Snapshots** — `docs/trustmybot/snapshots/<issue_id>.md`, written by `issue_snapshot_md`.

## Other docs

- **Authoring agent prompts** — [JUDGMENT_LAYER.md](../prompt-engineering/JUDGMENT_LAYER.md), with its evidence in [PROMPT_ENGINEERING.md](../prompt-engineering/PROMPT_ENGINEERING.md)
- **Agent layers and override rules** — [RESPONSIBILITIES.md](../architecture/RESPONSIBILITIES.md)
- **`plugin_config` keys** — [CONFIG_KEYS.md](./CONFIG_KEYS.md)
- **Full architecture** — [FLOWS.md](../architecture/FLOWS.md)
- **Memory model (hot and cold)** — [MEMORY.md](../architecture/MEMORY.md)

## MCP tools (full list)

88 tools; each one's schema and behavior is in `mcp/trajectory-server/src/tools/`, indexed by its [README](../../mcp/trajectory-server/src/tools/README.md).

- **issues**: `issue_create`, `issue_get`, `issue_list`, `issue_close`, `issue_link`, `issue_update_description`, `issue_update`, `issue_resume`, `issue_get_phase`, `issue_sync_retry`, `issue_adopt_remote`, `issue_reconcile_remote`
- **milestones**: `milestone_close`
- **tasks**: `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable`, `task_rework_analysis`
- **stats**: `task_stats`, `change_impact`
- **discussions**: `discussion_append`, `discussion_list`, `discussion_search`, `issue_get_with_discussions`
- **roundtable**: `roundtable_create`, `roundtable_vote`, `roundtable_close`, `roundtable_close_with_decisions`, `roundtable_finalize_decisions`, `roundtable_summarize`
- **PR monitor**: `pr_monitor_comments_get`, `pr_monitor_runs_list`
- **validation**: `validation_record`, `validation_history`
- **world model**: `world_model_get`, `scope_suggest`, `world_model_search`, `world_model_symbol`, `world_model_concepts`, `world_model_concept_get`, `world_model_concept_upsert`
- **onboard**: `onboard_state_get`, `onboard_get_questions`, `onboard_apply`
- **config**: `config_get`, `config_list`, `config_set`
- **scan**: `scan_run`, `repos_list`
- **repos**: `repo_rename`
- **reports**: `issue_report_md`, `issue_snapshot_md`, `branch_report_md`
- **cheatcodes**: `cheatcode_list`, `cheatcode_search`, `cheatcode_install`, `cheatcode_activate`, `cheatcode_approve`, `cheatcode_vet`, `cheatcode_uninstall`, `cheatcode_reconcile`
- **skills**: `skill_register`, `skill_promote`
- **agents**: `agent_list`, `agent_register`, `agent_resolve`
- **composites**: `intent_start`, `branch_id_propose`, `task_provision`, `task_brief`, `task_retry`, `task_recover`, `task_reopen`, `task_update_spec`, `review_handoff`, `bro_atomic_close`, `bro_verification_fail_record`, `pr_monitor_worktree`, `worktree_commits_fetch`
- **audit**: `audit_append`, `audit_list`, `audit_search`
- **metering backfill**: `agent_runs_backfill`
- **data contracts**: `trajectory_doctor`
- **bug report**: `bug_report_draft`
- **toolchain profiles**: `env_detect`, `env_record`, `env_get`

## Slash commands

Each command's procedure is in `commands/<name>.md`.

- `/onboard` — set or change the project's policy: identity, branching model, PR target, remotes, issue sync and the Bash sandbox. bro starts it on first contact; you run it for later changes.
- `/scan` — rebuild the world model and refresh the repos registry.
- `/dashboard` — start the local dashboard and print its URL.
- `/roundtable <topic>` — a multi-agent deliberation that you ratify.
- `/tmb:agent-create <role> <question>` — spawn a consultant for one domain question.

## Logs

All under `<project>/.claude/tmb/logs/`:

- `<date>-<session-id>.jsonl` — per-session Claude Code log capture
- `mcp-server.log` — MCP server tool calls
- `mcp-health.log` — SessionStart MCP samples and SubagentStop diagnostics
- `issue-sync.log` — issue-sync warnings and errors
- `sql.log` — SQL trace, when enabled

## Environment variables (selected)

- `TMB_DISABLE_REMOTE_SYNC` — when set, turns issue sync off whatever the config says
- `TRAJECTORY_DB_PATH` — pins the DB path for tests and CI (step 1 of [the DB location rule](./TRAJECTORY_DB_LOCATION.md))
- `CLAUDE_PLUGIN_ROOT` — set by Claude Code to the installed plugin's directory
- `TMB_RUN_SILENT_MIN` — minutes of silence before the liveness probe suspects a run or watcher (default 30, scaled up under load)
- `TMB_LIVENESS_POLL_S` — seconds between `liveness-sentinel` polls (default 60)
- `CLAUDE_CODE_SESSION_ATTENDED` — set by Claude Code; `liveness-sentinel` arms only at `1`

Hook-specific switches are named in their rows below.

## Hooks (SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / PermissionDenied / Stop / PreCompact / SubagentStart / SubagentStop / WorktreeCreate)

Each gate is `mcp/trajectory-server/src/hooks/<name>.ts`, wired through `hooks/hooks.json`. Every registration but the Stop entry `liveness-sentinel` runs the TypeScript router; [scripts/hooks/README.md](../../scripts/hooks/README.md) explains the router, its gate order, the Agent spawn dispatcher and the headless shim.

| Hook | Trigger | Purpose |
|---|---|---|
| `ensure-gitignore.ts` | SessionStart | The project `.gitignore` must exclude `.claude/` |
| `mcp-health-check.ts` | SessionStart | Sample MCP server presence (a soft note, never a HALT), plus install-scope and duplicate-copy notices |
| `deferred-tools-drift-warn.ts` | SessionStart | Warn when the MCP tools on disk are newer than the running server |
| `plugin-hooks-marker.ts` | SessionStart | Mark the session as running the plugin's own hooks, so the headless shim steps aside |
| `session-start-persona.ts` | SessionStart | Inject bro's persona, and after a compaction the state `session-handoff` recorded |
| `session-start-prescan.ts` | SessionStart | Inject the project inventory, plus a line for duplicate copies or leftover user-wide hooks |
| `ensure-mcp-deps-installed.ts` | SessionStart | Install the embedding runtime in the background when it is missing; embeddings go live on the next restart |
| `substrate-preflight.ts` | SessionStart | Check the trajectory DB and world model are reachable |
| `orphan-scan.ts` | SessionStart | Report stale DBs, duplicate server processes and unused caches left by upgrades; cleans only when opted in |
| `user-prompt-persona.ts` | UserPromptSubmit | Inject bro's persona once in a session that started without it |
| `activation-routine.ts` | UserPromptSubmit | Pre-fetch the onboarded marker and pending issue; HALT when the MCP server is down; one `/compact` nudge per session past `bro_compact_nudge_tokens` |
| `session-log-capture.ts` | UserPromptSubmit | Track the current Claude Code log for diagnostics |
| `prompt-intent-hints.ts` | UserPromptSubmit | Route intent phrases to the right guidance; asks one consent before enabling headless enforcement |
| `roundtable-slash-detect.ts` | UserPromptSubmit | Detect `/roundtable` for the server gate |
| `swe-resume-gate.ts` | PreToolUse SendMessage | Deny resuming a swe at the rework limit or at an effort other than its task's |
| `task-overrun-alert.ts` | UserPromptSubmit + PostToolUse trajectory-server | Tell bro once when a task or swe run passes `TMB_TASK_OVERRUN_MIN` minutes (default 60); never denies |
| `liveness-alert.ts` | UserPromptSubmit + PostToolUse trajectory-server | Tell bro about a silent subagent run or a hung watcher; never denies |
| `liveness-sentinel.ts` | Stop (`asyncRewake`, outside the router) | While bro is idle in an attended session, poll for silent runs and wake bro on a finding; reports only |
| `git-guards.ts` | PreToolUse Bash | Block `reset --hard`, `clean -fd` and force-pushes to protected branches |
| `git-push-guard.ts` | PreToolUse Bash | swe cannot push; a push needs a passing review |
| `swe-boundary.ts` | PreToolUse Bash + Edit/Write | Keep swe inside its worktree and scope; swe and code-reviewer get read-only `git stash` |
| `no-worktree-branch-create.ts` | PreToolUse Bash | bro creates branches; swe cannot `git worktree -b` |
| `stay-on-base-guard.ts` | PreToolUse Bash | Block code edits and commits on the base branch |
| `branch-up-to-date-with-remote.ts` | PreToolUse Bash | Block creating a worktree from a branch behind origin |
| `commit-msg-lint.ts` | PreToolUse Bash | Enforce the Conventional Commits subject format |
| `test-run-nudge.ts` | PreToolUse Bash | Advise swe to run a raw test command through `test-run.js`; `TMB_SKIP_TEST_RUN_NUDGE=1` lifts it |
| `no-remote-auth-guard.ts` | PreToolUse Bash | Block interactive forge logins (`gh` / `glab`) |
| `remote-id-guard.ts` | PreToolUse Bash | Guard remote-identity and repo-creation commands |
| `agent-spawn-dispatch.ts` | PreToolUse Agent | Run the swe and code-reviewer spawn gates in order, then prepare the swe worktree and record the spawn |
| `agent-arg-matches-caller.ts` | PreToolUse trajectory-server | Deny a call whose `agent` argument names another role than the caller |
| `swe-brief-gate.ts` | PreToolUse trajectory-server + Edit/Write | swe must fetch its task brief before touching state or files |
| `swe-verification-gate.ts` | PreToolUse trajectory-server (`task_update_status`) | Gate swe's close on the changelog, stale-doc and leak checks, then on verification |
| `reviewer-identity-observe.ts` | PreToolUse trajectory-server (`validation_record`) | Record the calling code-reviewer's identity for its verdict |
| `cheatcode-install-approval.ts` | PreToolUse trajectory-server (`cheatcode_install`) | Require the Human's approval before installing a cheatcode |
| `prompt-write-approval.ts` | PreToolUse Edit/Write/MultiEdit/Bash | Require the Human's recent approval before a non-swe write under `.claude/skills/` or `.claude/agents/` |
| `worktree-adopt-guard.ts` | PreToolUse trajectory-server (`task_provision`, `task_reopen`, `task_retry`) | Require `adopt_worktree` from a session in a linked worktree; refuse it elsewhere |
| `wm-read-before-provision.ts` | PreToolUse trajectory-server (`task_provision`) | Require a recent world-model read covering the task's files |
| `askuserquestion-length-lint.ts` | PreToolUse AskUserQuestion | Cap question label and description lengths |
| `roundtable-auq-shape.ts` | PreToolUse AskUserQuestion | Check the question shape while a roundtable awaits the Human |
| `no-source-edit-from-main.ts` | PreToolUse Edit/Write | bro edits only docs or prompts, and only in a running no-code task's worktree |
| `no-prose-in-scratch.ts` | PreToolUse Write/Edit/MultiEdit/NotebookEdit/Bash | Deny prose files in scratch and temp dirs, and forge bodies read from a file; `TMB_ALLOW_PROSE_SCRATCH=1` lifts it |
| `containment-guard.ts` | PreToolUse Write/Edit/MultiEdit/NotebookEdit/Bash | Deny a write outside the run's root: the swe's worktree, else the project |
| `swe-scope-fence.ts` | PreToolUse Edit/Write | Note, never deny, a swe edit outside the task's `files[]`; scope is judged at close |
| `naming-lint.ts` | PreToolUse Edit/Write | Enforce each language's naming convention |
| `code-quality-lint.ts` | PreToolUse Edit/Write | Warn, never deny, on mechanical quality patterns; `TMB_SKIP_CQ_LINT=1` lifts it |
| `debug-trajectory.ts` | PreToolUse Write/Edit, Bash, Agent, Read/Skill | Record trajectory rows under `TMB_EVAL_MODE=1` and `TMB_DEBUG_TRAJECTORY=1` |
| `swe-downstream-context.ts` | PreToolUse Write/Edit/MultiEdit/NotebookEdit | In the downstream-context experiment's `on` arm, show swe a file's direct downstream on its first edit |
| `cleanup-worktree-on-task-close.ts` | PostToolUse `task_update_status` + `validation_record` + `bro_atomic_close` | Remove the task's worktree once it closes after a passing review |
| `roundtable-cleanup-postcheck.ts` | PostToolUse `roundtable_close` | Check the roundtable's outcome was captured |
| `post-atomic-close-readme.ts` | PostToolUse `bro_atomic_close` | Nudge bro about touched directories whose README is stale or missing |
| `post-task-create-spawn-hint.ts` | PostToolUse task creation | Remind bro to spawn swe after provisioning a task |
| `bash-output-trim.ts` | PostToolUse Bash | Trim long output of provably read-only commands in bro's main thread |
| `attribution-footer.ts` | PostToolUse Bash | Append co-author and session attribution to commits |
| `clean-merged-branch.ts` | PostToolUse Bash | Prune local branches once their PR merges |
| `close-issue-on-merge.ts` | PostToolUse Bash | Close the local issue when its PR merges |
| `ref-move-reindex.ts` | PostToolUse Bash | Reindex a repo in the background after a command moves its refs; `TMB_SKIP_AUTO_RESCAN=1` turns it off |
| `swe-edit-lint.ts` | PostToolUse Write/Edit/MultiEdit | Run the repo's declared edit lints on a file swe edited, and block on the first failure |
| `swe-spawn-bind.ts` | PostToolUse Agent | Bind an accepted swe spawn's run row to its agent id |
| `swe-spawn-rollback.ts` | PermissionDenied Agent | Roll back a swe spawn that auto mode refused |
| `bro-turn-usage.ts` | Stop | Meter bro's token usage per session, asynchronously |
| `session-handoff.ts` | PreCompact | Record bro's state before a compaction for the persona to restore; `TMB_DISABLE_SESSION_HANDOFF_HOOK=1` turns it off |
| `reviewer-downstream-context.ts` | SubagentStart `tmb:code-reviewer` | In the downstream-context experiment's `on` arm, give code-reviewer the diff's direct downstream |
| `swe-atomic-close.ts` | SubagentStop | Close a swe task that committed with a passing verification run, else tell bro to resume it; record run metrics |
| `consultant-persistence-gate.ts` | SubagentStop | Persist a consultant's output before it exits |
| `worktree-create.ts` | WorktreeCreate | Enforce worktree-creation rules |

## Schema

[ERD.md](../architecture/ERD.md) lists every table.
