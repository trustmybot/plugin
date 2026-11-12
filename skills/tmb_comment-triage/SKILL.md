---
name: tmb_comment-triage
description: Bro's PR/MR comment triage — resolve the PR, fetch the comment threads, judge which are task-worthy, and dispatch SWE per group without waiting on the Human. Loaded by bro when review comments reach a PR it owns.
allowed-tools: Task, mcp__plugin_tmb_trajectory-server
---

# PR/MR comment triage

`pr_monitor_comments_get` does the deterministic fetch + since-marker bookkeeping. This skill is the judgment around what's task-worthy. Nothing here waits on the Human except a comment that would change the issue's intent or scope, because review comments are rework, and rework returns to its owner without the Human.

## Resolve the PR

Use the PR the trigger names: the one in the PR-activity notification or CI-monitor event, the one the Human pointed at, or the one you are checking. Otherwise find the PR you opened for the task, with `<branch>` the task's `branch_id` and `<slug>` the `owner/name` from `git -C <repo path> remote get-url origin` (`<repo path>` from `repos_list`):
- GitHub: `gh pr view <branch> -R <slug> --json number`
- GitLab: `glab mr list -R <slug> --source-branch <branch> --json`

Empty result → record the gap as a `discussion_append` note on the task's issue and skip the PR.

## Fetch

Call `pr_monitor_comments_get` with the PR number.

Carrier: resolve the linked issue with `branch_report_md` for the PR's head branch (or the task's `branch_id`), not the current checkout, rather than reading the DB directly. If unresolved, use the issue of the task whose branch the PR ships; if none resolves, record the gap as a `discussion_append` note and skip the PR.

## Triage (judgment)

Skip as informational when:
- The body is a bare acknowledgment — an LGTM, a +1, a thanks.
- The author is a bot (already classified by the MCP tool).
- The comment is already resolved.

A nit is neither skipped nor its own task: bundle it into the next task on that surface, as `tmb_push-gate` does with reviewer nits.

Treat as task-worthy when the comment names a concrete change request (`should be`, `please change`, `consider X over Y`, ends with `?`), or contains a code suggestion fence.

A comment that would change the issue's intent or scope is not dispatched: record it on the carrier issue with `discussion_append(kind='question')` and ask the Human.

Group the other task-worthy comments by file or shared concept; one task per group. Flag tasks that touch DB schema files (e.g. `schema/*.sql`), public API surfaces, or config directories (e.g. `agents/`, `skills/`, plugin manifest files) as `(arch-impact)`.

## Dispatch

Dispatch every group; none waits for the Human to pick:
- **A closed task on the PR's branch owns the touched surface:** `task_reopen(task_id, reason, files_add?)` with the comments in `reason`, so the fix lands on the same branch and PR.
- **Otherwise:** `task_provision(issue_id, branch_id, decision_body, task)` on the carrier issue — it creates the branch and worktree.

Then run the same chain as `tmb_planning` §5-6: swe → `review_handoff` → code-reviewer → `bro_atomic_close` → push. If arch-impact, invoke `scan_run` once its PR merges to refresh the world model.
