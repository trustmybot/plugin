# src/tools

The MCP tool modules for the trajectory server — one TypeScript file per domain. Each module exports a factory (e.g. `issueTools(db)`) returning `{ definitions, handlers }`: the JSON-Schema tool definitions Claude sees and the handlers that run against the SQLite trajectory DB (and, for some, the kuzu world-model graph). `index.ts` wires every module's definitions + handlers together and decorates each with the `agent` param used for role-gating.

## Grouped by domain

| Domain | File | Tools |
|---|---|---|
| Issues | `issues.ts` | `issue_create`, `issue_get`, `issue_list`, `issue_resume`, `issue_close`, `issue_link`, `issue_update_description`, `issue_get_phase`, `issue_sync_retry` |
| Tasks | `tasks.ts` | `task_create_batch`, `task_get`, `task_update_status`, `task_first_actionable` |
| Discussions | `discussions.ts` | `discussion_append`, `discussion_list`, `discussion_search`, `issue_get_with_discussions` |
| Audit | `audit.ts` | `audit_append`, `audit_list`, `audit_search` |
| Validation | `validation.ts` | `validation_record`, `validation_history` |
| Composites | `composites.ts` | multi-step orchestration helpers: `task_brief`, `task_provision`, `intent_start`, `branch_id_propose`, `bro_atomic_close`, `task_recover`, `bro_verification_fail_record`, `pr_monitor_worktree`, `worktree_commits_fetch`, `task_retry` |
| Agents | `agents.ts` | `agent_register`, `agent_list`, `agent_resolve` |
| Skills | `skills.ts` | `skill_register`, `skill_promote` |
| Cheatcodes | `cheatcode.ts` | `cheatcode_search`, `cheatcode_vet`, `cheatcode_approve`, `cheatcode_install`, `cheatcode_activate`, `cheatcode_uninstall` |
| Roundtable | `roundtable.ts` | `roundtable_create`, `roundtable_vote`, `roundtable_summarize`, `roundtable_finalize_decisions`, `roundtable_close`, `roundtable_close_with_decisions` |
| PR monitor | `pr_monitor.ts` | `pr_monitor_comments_get`, `pr_monitor_runs_list` |
| Reports | `reports.ts` | `issue_report_md`, `issue_snapshot_md` |
| Branch report | `branch_report_md.ts` | `branch_report_md` |
| Stats | `stats.ts` | `task_stats` |
| Config | `config.ts` | `config_get`, `config_set`, `config_list` |
| Onboard | `onboard.ts` | `onboard_state_get`, `onboard_get_questions`, `onboard_apply` (+ `origin` helper) |
| Scan | `scan.ts` | `scan_run` (forks `scripts/scan.sh`), `repos_list` |
| World model | `world_model.ts` | `world_model_get`, `world_model_search` (kuzu graph) |

`onboard-hooks-shim.ts` is a non-tool helper: it writes the plugin's PreToolUse hooks into the user's `settings.json` so they fire in non-interactive `claude -p` runs, where marketplace plugin hooks are absent.

## How it fits

These modules are the entire MCP surface bro and the subagents call. `index.ts` is the registration point; role-gating per tool is enforced by `requireRoles()` in `../middleware/agent-scope.ts`. See `../../README.md` for the tool-family overview, environment, and schema notes. Handlers are unit-tested at L2 (`../test/`).

## Atomicity notes

`task_provision` is atomic from the caller's view: it resolves the repo path and validates the branch `base` (`git rev-parse` on `origin/<base>`), then creates the branch ref, all **before** committing the decision + task transaction. A git-setup failure (unresolvable repo or base, failed branch creation) returns a tool error and persists nothing — no orphan task row is left occupying the `(issue_id, branch_id)` UNIQUE constraint, so the same `branch_id` retries cleanly once the repo/base resolves. Only worktree creation stays fail-soft (post-commit, recoverable): a worktree failure returns `git_setup:'error'` with a diagnostic but keeps the committed task.
