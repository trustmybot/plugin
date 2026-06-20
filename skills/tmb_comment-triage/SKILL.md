---
name: tmb_comment-triage
description: Bro's PR/MR comment triage — resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per ratified group. Loaded by bro when /monitor surfaces PR/MR comments.
allowed-tools: Task, AskUserQuestion, mcp__plugin_tmb_trajectory-server
---

# PR/MR comment triage

`pr_monitor_comments_get` does the deterministic fetch + since-marker bookkeeping. This skill is the judgment around what's task-worthy.

## Resolve the PR

If the Human named a PR number, use it. Otherwise:
- GitHub: `gh pr view --json number`
- GitLab: `glab mr list --source-branch <branch> --json`

Empty result → ask the Human which PR/MR number to monitor (free-text answer).

## Fetch

Call `pr_monitor_comments_get` with the PR number.

Carrier: look up the issue via `tasks.branch_id` for the current branch. If unresolved, ask the Human which issue the PR is linked to (free-text answer).

## Triage (judgment)

Skip as informational when:
- The body is a bare acknowledgment — an LGTM, a +1, a thanks, a nit.
- The author is a bot (already classified by the MCP tool).
- The comment is already resolved.

Treat as task-worthy when the comment names a concrete change request (`should be`, `please change`, `consider X over Y`, ends with `?`), or contains a code suggestion fence.

Group task-worthy comments by file or shared concept; one task per group. Flag tasks that touch DB schema files (e.g. `schema/*.sql`), public API surfaces, or config directories (e.g. `agents/`, `skills/`, plugin manifest files) as `(arch-impact)`.

## Dispatch

Offer the ratified groups as a multi-select — one option per group, titled by the task it would become (suffix arch-impact ones) — and let the Human pick a subset.

For each ratified group: `task_create_batch(...)`, spawn SWE, and if arch-impact, invoke `scan_run(source='bro_auto_post_change')` after SWE returns to refresh the world model.
