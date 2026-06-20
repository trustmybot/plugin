---
name: tmb_push-triage
description: Bro's push-gate orchestration and PR/MR comment triage — reaping unsigned commits, spawning pr-reviewer per task, the all-pass push + PR-create + post-merge cleanup path, and turning PR-comment threads into tasks. Loaded by bro when the push hook blocks, the Human asks for review-before-push, or /monitor surfaces PR comments.
allowed-tools: Task, AskUserQuestion, mcp__plugin_tmb_trajectory-server
---

# Push-gate orchestration & comment triage

pr-reviewer judges each diff against its own spec; you judge the change at the system level — does it fit the architecture, disturb a cross-cutting surface (agents, schema, hooks, public API), and is the overall scope right?

## A. Spawning pr-reviewer

The verdict row is always authored by pr-reviewer itself — via `validation_record` when MCP is available, via the fallback script otherwise (pr-reviewer's `tmb_review` owns that fallback). <!-- LOAD-BEARING-SAFETY: pr-reviewer must write validation_attempts directly; delegating to bro is impersonation and is blocked by the auto-mode classifier -->

**Clean spawn prompt example:**
```
task_id=42 commit_sha=abc123def branch_id=fix/foo repo=plugin attempt_n=<attempt #>

Push-gate review. Load the brief, verify each Success Criterion against the diff, and record your verdict — fail if any check fails.
```

No-MCP fallback (Bash-only spawn, no `mcp__...` tools in the reviewer's tool list): just spawn pr-reviewer as above. The reviewer writes its own verdict through `tmb_review`'s fallback script and reports `MCP available: no — honor-system fallback`; you do not hand it a DB-access pointer.

## B. Push-gate orchestration (loaded reactively)

This loads when the push guard blocks unsigned commits, or when the Human asks to review before pushing.

### Reap commits → local feature branch

`reap_and_review_prep` fetches each unsigned task's detached HEAD into the main checkout and reports per task whether the reap landed.

### Spawn pr-reviewer per unsigned task (parallel)

Use `subagent_type='pr-reviewer'` (no-namespace form resolves project-local override). Tasks are independent; spawn in parallel where possible.

Read pr-reviewer's first response line:
- `MCP available: yes` — the reviewer wrote `validation_record` itself.
- `MCP available: no — honor-system fallback` — the reviewer wrote the row through the `tmb_review` fallback script, which prepends the required feedback prefix itself.

### Outcomes

- All-pass → `git push origin <feature>`, then `gh pr create` / `glab mr create`, surface URL. After merge, run post-merge cleanup below.
- Any fail → surface verbatim. AUQ: `"PR-reviewer failed on N task(s). Spawn SWE to fix, or abort the push?"` options: `[Spawn SWE to fix | Abort push]`.

### Post-merge cleanup

`git switch <pr_target> && git pull --ff-only && git branch -d <feature>`. The cleanup-on-task-close hook removes the SWE worktree automatically on task close.

## C. PR/MR comment triage (loaded by /monitor)

`pr_monitor_comments_get` does the deterministic fetch + since-marker bookkeeping. This section is the judgment around what's task-worthy.

### Resolve the PR

If the Human named a PR number, use it. Otherwise:
- GitHub: `gh pr view --json number`
- GitLab: `glab mr list --source-branch <branch> --json`

Empty result → ask the Human which PR/MR number to monitor (free-text answer).

### Fetch

Call `pr_monitor_comments_get` with the PR number.

Carrier: look up the issue via `tasks.branch_id` for the current branch. If unresolved, ask the Human which issue the PR is linked to (free-text answer).

### Triage (judgment)

Skip as informational when:
- The body is a bare acknowledgment — an LGTM, a +1, a thanks, a nit.
- The author is a bot (already classified by the MCP tool).
- The comment is already resolved.

Treat as task-worthy when the comment names a concrete change request (`should be`, `please change`, `consider X over Y`, ends with `?`), or contains a code suggestion fence.

Group task-worthy comments by file or shared concept; one task per group. Flag tasks that touch DB schema files (e.g. `schema/*.sql`), public API surfaces, or config directories (e.g. `agents/`, `skills/`, plugin manifest files) as `(arch-impact)`.

### Dispatch

Offer the ratified groups as a multi-select — one option per group, titled by the task it would become (suffix arch-impact ones) — and let the Human pick a subset.

For each ratified group: `task_create_batch(...)`, spawn SWE, and if arch-impact, invoke `scan_run(source='bro_auto_post_change')` after SWE returns to refresh the world model.
