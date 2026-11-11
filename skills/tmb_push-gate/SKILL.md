---
name: tmb_push-gate
description: Bro's push-gate orchestration — reaping unsigned commits, spawning code-reviewer per task, and the all-pass push + PR-create + post-merge cleanup path. Loaded by bro when the push hook blocks or the Human asks for review-before-push.
allowed-tools: Task, AskUserQuestion, mcp__plugin_tmb_trajectory-server
---

# Push-gate orchestration

code-reviewer judges each diff against its own spec; you judge the change at the system level — does it fit the architecture, disturb a cross-cutting surface (agents, schema, hooks, public API), and is the overall scope right?

## A. Spawning code-reviewer

The verdict row is always authored by code-reviewer itself — via `validation_record` when MCP is available, via the fallback script otherwise (code-reviewer's `tmb_review` owns that fallback). <!-- LOAD-BEARING-SAFETY: code-reviewer must write validation_attempts directly; delegating to bro is impersonation and is blocked by the auto-mode classifier -->

The spawn prompt carries the anchors only; the reviewer reads the spec, the task's decision and intent rows, the issue's newest decision and intent, the completion report and open findings from `task_brief`, and asks for the other discussion bodies with `response_format: 'detailed'` when it needs them. Context it cannot read there goes in `review_handoff`'s `spawn_note` (300 characters max), which `task_brief` returns; a spawn gate denies a prompt carrying more than 300 characters of prose beyond the anchors.

Code-reviewer reviews the completed task before bro closes it. Pass your `session_id` to `review_handoff`, then spawn code-reviewer with `reviewer_spawn.prompt`, `.effort` and `.subagent_type` exactly as returned, plus its `model` when present (omit it when absent); when it returns `reviewer_spawn_unavailable` instead, build the anchors by hand as in the example below. Close with `bro_atomic_close` once the verdict is a pass.

**Clean spawn prompt example:**
```
task_id=42 commit_sha=abc123def branch_id=fix/foo repo=plugin repo_path=<repo path> attempt_n=<attempt #> subagent_session_id=<spawned reviewer session id>
```

No-MCP fallback (Bash-only spawn, no `mcp__...` tools in the reviewer's tool list): just spawn code-reviewer as above. The reviewer writes its own verdict through `tmb_review`'s fallback script, which records `mcp_available = 0` on the row; you do not hand it a DB-access pointer.

## B. Push-gate orchestration (loaded reactively)

This loads when the push guard blocks unsigned commits, or when the Human asks to review before pushing.

### Reap commits → local feature branch

`worktree_commits_fetch` fetches each unsigned task's detached HEAD into the main checkout and reports per task whether the fetch landed.

### Spawn code-reviewer per unsigned task (parallel)

Spawn each task's reviewer with the `reviewer_spawn` its `review_handoff` returned: `prompt`, `effort` and `subagent_type` exactly as returned, plus `model` when present (omit it when absent). Tasks are independent; spawn in parallel where possible. When that `reviewer_spawn` is not in hand, use `tmb:code-reviewer` and the model and effort assigned to that task (the `require-spawn-effort` deny names them).

Read the verdict and `mcp_available` from each task's validation row via `validation_history`, the typed source of truth, not from the reviewer's reply text:
- `mcp_available = 1` — the reviewer wrote `validation_record` itself.
- `mcp_available = 0` — the reviewer wrote the row through the `tmb_review` fallback script (honor-system, MCP was unavailable).

### Outcomes

`<repo path>` is the task's repo `path` from `repos_list`; `<slug>` is that repo's `owner/name` from `git -C <repo path> remote get-url origin`.

- All-pass → `git -C <repo path> push origin <feature>`, then `gh pr create -R <slug> --head <feature> --base <pr_target>` / `glab mr create -R <slug> --source-branch <feature> --target-branch <pr_target>`, surface URL. After merge, run post-merge cleanup below. A pass can carry `nit` and `pre_existing` findings (its `return_line` counts them as `findings=<n>`): bundle each nit into the next task on that surface, or close it as wontfix with a reason (`task_reopen` `wontfix`); file each pre_existing finding as a GitHub issue.
- Any fail → the FAIL already reopened the task: `running` at `effort='high'`, with a `spawn_note` naming the blocking finding ids and their `class` (`validation_record` returns it as `reopened`; `task_get` shows it). Surface the FAIL verbatim, hold the push, and spawn swe at `effort='high'`. When `require-task-spec` denies the spawn for a missing worktree, call `task_reopen(task_id, reason)` first; it recreates the worktree. On `reopen_skipped`, handle the task by its current status.
- Rework on a branch with an open PR → `git -C <repo path> push origin <feature>`, then confirm `git -C <repo path> rev-parse origin/<feature>` equals the local tip (`git -C <repo path> rev-parse <feature>`) before telling the Human the PR is updated.

### Post-merge cleanup

Once `gh pr view <n> -R <slug> --json state` reports `MERGED` (`glab mr view <n> -R <slug> --output json` reports `merged`): `git -C <repo path> switch <pr_target> && git -C <repo path> pull --ff-only && git -C <repo path> branch -D <feature> && git -C <repo path> fetch --prune`. A squash merge leaves `<feature>` unmerged by ancestry, so the confirmed merge state is what clears it for `-D`; any other state leaves the branch in place. The SWE worktree stays through task close and is removed automatically once code-reviewer passes the task or the branch merges, so a failed review reworks in place.
