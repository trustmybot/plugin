# src/tools

The MCP tool modules for the trajectory server — one TypeScript file per domain. Each module exports a factory (e.g. `issueTools(db)`) returning `{ definitions, handlers }`: the JSON-Schema tool definitions Claude sees and the handlers that run against the SQLite trajectory DB (and, for some, the kuzu world-model graph). `index.ts` wires every module's definitions + handlers together and decorates each with the `agent` param used for role-gating.

## Grouped by domain

| Domain | File | Tools |
|---|---|---|
| Issues | `issues.ts` | `issue_create`, `issue_get`, `issue_list`, `issue_resume`, `issue_close`, `issue_link`, `issue_update_description`, `issue_get_phase`, `issue_sync_retry`, `issue_adopt_remote` |
| Milestones | `milestones.ts` | `milestone_close` |
| Tasks | `tasks.ts` | `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable` |
| Discussions | `discussions.ts` | `discussion_append`, `discussion_list`, `discussion_search`, `issue_get_with_discussions` |
| Audit | `audit.ts` | `audit_append`, `audit_list`, `audit_search` |
| Validation | `validation.ts` | `validation_record`, `validation_history` |
| Composites | `composites.ts` | multi-step orchestration helpers: `task_brief`, `task_provision`, `intent_start`, `branch_id_propose`, `bro_atomic_close`, `task_recover`, `bro_verification_fail_record`, `pr_monitor_worktree`, `worktree_commits_fetch`, `task_retry`, `task_reopen`, `task_update_spec` |
| Agents | `agents.ts` | `agent_register`, `agent_list`, `agent_resolve` |
| Skills | `skills.ts` | `skill_register`, `skill_promote` |
| Cheatcodes | `cheatcode.ts` | `cheatcode_search`, `cheatcode_vet`, `cheatcode_approve`, `cheatcode_install`, `cheatcode_activate`, `cheatcode_uninstall` |
| Roundtable | `roundtable.ts` | `roundtable_create`, `roundtable_vote`, `roundtable_summarize`, `roundtable_finalize_decisions`, `roundtable_close`, `roundtable_close_with_decisions` |
| PR monitor | `pr_monitor.ts` | `pr_monitor_comments_get`, `pr_monitor_runs_list` |
| Reports | `reports.ts` | `issue_report_md`, `issue_snapshot_md` |
| Branch report | `branch_report_md.ts` | `branch_report_md` |
| Stats | `stats.ts` | `task_stats` |
| Config | `config.ts` | `config_get`, `config_set`, `config_list` |
| Onboard | `onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` (+ `origin` helper). Both `onboard_get_questions` and `onboard_apply` take an optional `repo=<name>` param (round='main', shape='remote') to scope the branching + pr_target questions/writes to a single `repos` row; omitting it preserves the workspace-wide behaviour. |
| Scan | `scan.ts` | `scan_run` (forks `scripts/scan.sh`), `repos_list` |
| World model | `world_model.ts` | `world_model_get` (kuzu graph + an `unmerged_work` field: closed-task branches with a live local ref whose tip is not yet merged into the target), `world_model_search` |

`onboard-hooks-shim.ts` is a non-tool helper: when the project opts in (`headless_enforcement: yes`), it writes the plugin's PreToolUse gates into the project's `.claude/settings.local.json` so they fire in non-interactive `claude -p` runs, where marketplace plugin hooks are absent; `no` removes them. It writes nothing outside the project. `onboard-sandbox.ts` writes or removes Claude Code's Bash sandbox block in the same file (`sandbox_enforcement`, default no). `agent-runs.ts` opens and closes `agent_runs` rows with their `root_dir`, `host` and `exit_reason`; `containment.ts` holds the `outside_project` check the path-taking tools share. `lifecycle.ts` holds the issue/task lifecycle rules `issue_close`, `bro_atomic_close`, `task_recover` and `task_update_status` share: the live-task set, the passing-review rule behind `review_gate_bypassed` / `tasks_without_review`, the `issue_close` cascade, and the stale-running sweep.

## How it fits

These modules are the entire MCP surface bro and the subagents call. `index.ts` is the registration point; role-gating per tool is enforced by `requireRoles()` in `../middleware/agent-scope.ts`. See `../../README.md` for the tool-family overview, environment, and schema notes. Handlers are unit-tested at L2 (`../test/`).

## Discussions: single insert+embed path

Every discussion write — `discussion_append` plus every composite that logs an `intent` / `decision` / `note` (`task_provision`, `intent_start`, `task_retry`, `bro_verification_fail_record`) — goes through one helper, `insertDiscussion(db, { issue_id, author, kind, body, created_at? })` in `discussions.ts`. It INSERTs the row and fires `embedAndStore` so the entry is indexed for semantic `discussion_search`. The embed is not awaited and its failure is caught (degrades to FTS-only), so when a composite calls it inside `db.transaction()` the embedding write lands after COMMIT and an embed failure never rolls back the transaction. No module writes the `discussions` table directly.

## Atomicity notes

`task_provision` is atomic from the caller's view: it resolves the repo path and validates the branch `base` (`git rev-parse` on `origin/<base>`), then creates the branch ref, all **before** committing the decision + task transaction. A git-setup failure (unresolvable repo or base, failed branch creation) returns a tool error and persists nothing — no orphan task row is left occupying the `(issue_id, branch_id)` UNIQUE constraint, so the same `branch_id` retries cleanly once the repo/base resolves. Only worktree creation stays fail-soft (post-commit, recoverable): a worktree failure returns `git_setup:'error'` with a diagnostic but keeps the committed task. `git_setup:'created'` means a new ref from `base`; an existing local or origin ref at or behind the base tip is fast-forwarded and reported `'reused'`; a diverged ref is refused with `branch_exists_diverged` (ref, ahead/behind distance, open PRs read with `gh pr list --head` / `glab mr list --source-branch` under the issue-sync gate) unless `reuse_existing: true` keeps it as-is (`'reused'`). `worktree_reused` reports an existing worktree separately.

`task_reopen` and `task_update_spec` (bro only) change a task after provision. `task_reopen` moves a `closed` / `failed` / `escalated` / `running` task to `running`, appends `files_add` / `verification_add` to its fences, writes a `decision` discussion + `task_reopened` audit row, opens a bro `agent_runs` row for the rework (reusing an open one; optional `session_id`), and recreates the worktree when missing (the same idempotent setup `task_provision` uses); it refuses a task whose issue is closed. `task_update_spec` replaces `files` / `verification` / `spec_body` of a `pending` / `running` / `needs_validation` / `completed` task with a `decision` discussion + `task_spec_amended` audit row carrying the old→new summary; the scope fence and verification gate read the new values from the DB on their next run.
