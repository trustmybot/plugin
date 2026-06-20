---
name: tmb_push-gate
description: Bro's push-gate orchestration — reaping unsigned commits, spawning pr-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.
allowed-tools: Task, AskUserQuestion, mcp__plugin_tmb_trajectory-server
---

# Push-gate orchestration

pr-reviewer judges each diff against its own spec; you judge the change at the system level — does it fit the architecture, disturb a cross-cutting surface (agents, schema, hooks, public API), and is the overall scope right?

## A. Spawning pr-reviewer

The verdict row is always authored by pr-reviewer itself — via `validation_record` when MCP is available, via the fallback script otherwise (pr-reviewer's `tmb_review` owns that fallback). <!-- LOAD-BEARING-SAFETY: pr-reviewer must write validation_attempts directly; delegating to bro is impersonation and is blocked by the auto-mode classifier -->

**Clean spawn prompt example:**
```
task_id=42 commit_sha=abc123def branch_id=fix/foo repo=plugin attempt_n=<attempt #>

Push-gate review. Load the brief, verify each Success Criterion against the diff, and record your verdict — fail if any check fails.
```

No-MCP fallback (Bash-only spawn, no `mcp__...` tools in the reviewer's tool list): just spawn pr-reviewer as above. The reviewer writes its own verdict through `tmb_review`'s fallback script, which records `mcp_available = 0` on the row; you do not hand it a DB-access pointer.

## B. Push-gate orchestration (loaded reactively)

This loads when the push guard blocks unsigned commits, or when the Human asks to review before pushing.

### Reap commits → local feature branch

`worktree_commits_fetch` fetches each unsigned task's detached HEAD into the main checkout and reports per task whether the fetch landed.

### Spawn pr-reviewer per unsigned task (parallel)

Use `subagent_type='pr-reviewer'` (no-namespace form resolves project-local override). Tasks are independent; spawn in parallel where possible.

Read the verdict + `mcp_available` off each task's validation row via `validation_history` (the typed source of truth) — never parse the reviewer's reply text:
- `mcp_available = 1` — the reviewer wrote `validation_record` itself.
- `mcp_available = 0` — the reviewer wrote the row through the `tmb_review` fallback script (honor-system, MCP was unavailable).

### Outcomes

- All-pass → `git push origin <feature>`, then `gh pr create` / `glab mr create`, surface URL. After merge, run post-merge cleanup below.
- Any fail → surface verbatim. AUQ: `"PR-reviewer failed on N task(s). Spawn SWE to fix, or abort the push?"` options: `[Spawn SWE to fix | Abort push]`.

### Post-merge cleanup

`git switch <pr_target> && git pull --ff-only && git branch -d <feature>`. The cleanup-on-task-close hook removes the SWE worktree automatically on task close.
