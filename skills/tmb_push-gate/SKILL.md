---
name: tmb_push-gate
description: Bro's push-gate orchestration — reaping unsigned commits, spawning code-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.
allowed-tools: Task, AskUserQuestion, mcp__plugin_tmb_trajectory-server
---

# Push-gate orchestration

code-reviewer judges whether the diff breaks other behaviour; you judge whether the change fits the design and the spec's intent, re-running no checks and re-reviewing no diff.

The per-task order (swe returns → `review_handoff` → code-reviewer → `bro_atomic_close`), the spawn note and rework after a FAIL live in `tmb_planning` §5-6. This skill covers what the push adds.

## A. Spawning code-reviewer

The verdict row is always authored by code-reviewer itself — via `validation_record` when MCP is available, via the fallback script otherwise (code-reviewer's `tmb_review` owns that fallback). <!-- LOAD-BEARING-SAFETY: code-reviewer must write validation_attempts directly; delegating to bro is impersonation and is blocked by the auto-mode classifier -->

Every reviewer spawn follows `review_handoff`: pass your `session_id`, then spawn code-reviewer with `reviewer_spawn.prompt`, `.effort` and `.subagent_type` exactly as returned, plus its `model` when present (omit it when absent). When it returns `reviewer_spawn_unavailable` instead, build the anchors by hand as in the example below, with the effort the handoff assigned.

**Clean spawn prompt example:**
```
task_id=42 commit_sha=abc123def branch_id=fix/foo repo=plugin repo_path=<repo path> attempt_n=<attempt #> subagent_session_id=<spawned reviewer session id>
```

No-MCP fallback (Bash-only spawn, no `mcp__...` tools in the reviewer's tool list): spawn code-reviewer as above. The reviewer writes its own verdict through `tmb_review`'s fallback script, which records `mcp_available = 0` on the row; you do not hand it a DB-access pointer.

## B. Push-gate orchestration (loaded reactively)

This loads when the push guard blocks unsigned commits, or when the Human asks to review before pushing.

### Reap commits → local feature branch

`worktree_commits_fetch` fetches each unsigned task's detached HEAD into the main checkout and reports per task whether the fetch landed.

### Spawn code-reviewer per unsigned task (parallel)

Hand off each unsigned task with `review_handoff` and spawn its reviewer as in §A. Tasks are independent; spawn in parallel where possible.

Read the verdict and `mcp_available` from each task's validation row via `validation_history`, the typed source of truth, not from the reviewer's reply text:
- `mcp_available = 1` — the reviewer wrote `validation_record` itself.
- `mcp_available = 0` — the reviewer wrote the row through the `tmb_review` fallback script (honor-system, MCP was unavailable).

### Outcomes

`<repo path>` is the task's repo `path` from `repos_list`; `<slug>` is that repo's `owner/name` from `git -C <repo path> remote get-url origin`.

- All-pass → judge each task's architecture fit and close it with `bro_atomic_close` (`tmb_planning` §6), writing your fit judgment into its `verification_summary`; a misfit goes back to the spec as §6 describes. When the base moved, integrate first (`tmb_planning` §6, "Integrate after the review pass"). Then `git -C <repo path> push origin <feature>`, then `gh pr create -R <slug> --head <feature> --base <pr_target>` / `glab mr create -R <slug> --source-branch <feature> --target-branch <pr_target>`, and surface the URL. The Human merges, unless the project's merge policy delegates merging; after the merge, run the post-merge cleanup below. A pass can carry `nit` and `pre_existing` findings (its `return_line` counts them as `findings=<n>`): bundle each nit into the next task on that surface, or close it as wontfix with a reason (`task_reopen` `wontfix`); file each pre_existing finding as a GitHub issue.
- Any fail → hold the push and rework the task as `tmb_planning` §6 describes. When `require-task-spec` denies the spawn for a missing worktree, call `task_reopen(task_id, reason)` first; it recreates the worktree. On `reopen_skipped`, handle the task by its current status.
- Rework on a branch with an open PR → `git -C <repo path> push origin <feature>`, then confirm `git -C <repo path> rev-parse origin/<feature>` equals the local tip (`git -C <repo path> rev-parse <feature>`) before telling the Human the PR is updated.

### Post-merge cleanup

Once `gh pr view <n> -R <slug> --json state` reports `MERGED` (`glab mr view <n> -R <slug> --output json` reports `merged`): remove any task worktree still on `<feature>` (`git -C <repo path> worktree list`, then `git -C <repo path> worktree remove <path>`), then `git -C <repo path> switch <pr_target> && git -C <repo path> pull --ff-only && git -C <repo path> branch -D <feature> && git -C <repo path> fetch --prune`. The worktree goes first because git refuses to delete a branch a worktree has checked out. A squash merge leaves `<feature>` unmerged by ancestry, so the confirmed merge state is what clears it for `-D`; any other state leaves the branch and its worktree in place.
