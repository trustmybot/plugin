---
name: tmb_push-gate
description: Bro's push-gate orchestration — reaping unsigned commits, spawning code-reviewer per task, the all-pass push + PR-create + post-merge cleanup path, and the agile milestone review of a feature branch. Loaded by bro when the push hook blocks, the Human asks for review-before-push, or an agile milestone is reached.
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

- All-pass → judge each task's architecture fit and close it with `bro_atomic_close` (`tmb_planning` §6), writing your fit judgment into its `verification_summary`; a misfit goes back to the spec as §6 describes. When the base moved, integrate first (`tmb_planning` §6, "Integrate after the review pass"). Then check for a remote with `git -C <repo path> remote get-url origin`. When it fails, stop at branch ready: skip the push and the PR, and tell the Human that `<feature>` is ready to merge locally into `<pr_target>`, because with no forge there is no PR to merge and the local merge is the Human's. With origin, `git -C <repo path> push origin <feature>`, then `gh pr create -R <slug> --head <feature> --base <pr_target>` / `glab mr create -R <slug> --source-branch <feature> --target-branch <pr_target>`, and surface the URL. The Human merges, unless the project's merge policy delegates merging; after the merge, run the post-merge cleanup below. A pass can carry `nit` and `pre_existing` findings (its `return_line` counts them as `findings=<n>`): bundle each nit into the next task on that surface, or close it as wontfix with a reason (`task_reopen` `wontfix`); file each pre_existing finding as a GitHub issue.
- Any fail → hold the push and rework the task as `tmb_planning` §6 describes. When `require-task-spec` denies the spawn for a missing worktree, call `task_reopen(task_id, reason)` first; it recreates the worktree. On `reopen_skipped`, handle the task by its current status.
- Rework on a branch with an open PR → `git -C <repo path> push origin <feature>`, then confirm `git -C <repo path> rev-parse origin/<feature>` equals the local tip (`git -C <repo path> rev-parse <feature>`) before telling the Human the PR is updated.

### Post-merge cleanup

Once `gh pr view <n> -R <slug> --json state` reports `MERGED` (`glab mr view <n> -R <slug> --output json` reports `merged`): remove any task worktree still on `<feature>` (`git -C <repo path> worktree list`, then `git -C <repo path> worktree remove <path>`), then `git -C <repo path> switch <pr_target> && git -C <repo path> pull --ff-only && git -C <repo path> branch -D <feature> && git -C <repo path> fetch --prune`. The worktree goes first because git refuses to delete a branch a worktree has checked out. A squash merge leaves `<feature>` unmerged by ancestry, so the confirmed merge state is what clears it for `-D`; any other state leaves the branch and its worktree in place.

With no remote, start once the Human says the local merge is done: remove the task worktree the same way, then `git -C <repo path> switch <pr_target> && git -C <repo path> branch -d <feature>`, with no pull or fetch. When `-d` refuses because a squash merge left `<feature>` unmerged by ancestry, ask the Human before running `git -C <repo path> branch -D <feature>`, since no forge confirms the merge.

## C. Agile milestone review

Under the `agile` review mode (`tmb_planning`, "Agile review mode") the closed tasks wait on the feature branch `<feature>`, queued for one grouped review. Start when the Human says the milestone is reached. `<feature-branch>` and the backup push are as defined there, and each repo the milestone touches runs these steps on its own feature branch.

1. **Sync the working branch in.** Run `<feature-branch> sync <feature> --repo <repo>`, the same command as any optional sync before the milestone. It fetches `<pr_target>` when the repo has a remote, merges `origin/<pr_target>` (or the local `<pr_target>` with no remote) into `<feature>` in a temporary worktree, and prints the tip; a `<feature>` that already holds it is left as is.
   - **Exit 0** — synced; make the backup push.
   - **Exit 2** — a conflict: the merge is aborted, `<feature>` is unchanged, and stderr lists the conflicting paths. Read what each side changed in each path, `git -C <repo path> diff <base ref>...<feature> -- <path>` and `git -C <repo path> diff <feature>...<base ref> -- <path>`, with `<base ref>` the branch sync merged. When the intent of both sides is clear, settle it on the feature branch with a sync task, so the resolution is verified, landed and reviewed like any other change: `task_provision base=<feature>` with a spec that merges `<base ref>` into the task branch and resolves each path the way you state. It closes and lands like any agile task (`tmb_planning`, "Agile review mode" steps 2–3), and the files the merge brings in come back as scope extras, which the merge explains. Then run sync again. When either side's intent is unclear, ask the Human how to resolve each path; `<feature>` stays unsynced until they answer.
   - **Exit 4** — a precondition failed, such as `<feature>` checked out in a worktree (switch that worktree off it first); surface its stderr, fix the cause and rerun.
2. **Group the queue.** `review_queue(agent='bro', repo)` returns the queued tasks in groups whose declared `files[]` overlap; keep the tasks whose `parent_branch_id` (`task_get`) is `<feature>`. A task counts as queued on `<feature>` only once `feature-merge` has landed it there, so the hand-off refuses any other with `task_not_queued`: land it first.
3. **Hand off each group.** Call `review_batch_handoff(agent='bro', feature_branch=<feature>, task_ids, session_id)` once per group. It runs the close lints at the feature tip and refuses a group that leaves out a queued task sharing one of its changed files: add the tasks `group_splits_shared_file` lists and call again. On `lint_failed`, a close lint or the suite failed at the tip: file the failure as a fix task (step 5), and hand the group off again once the fix has landed.
4. **Review in parallel.** Spawn one code-reviewer per handoff, all in one message, with `reviewer_spawn.prompt`, `.effort` and `.subagent_type` exactly as returned. When the spawn gate denies one because the feature tip moved since its handoff, call `review_batch_handoff` for that group again. A pass batch-reviews every task of the group; a FAIL leaves them queued.
5. **Rework a FAIL.** Each FAIL becomes a fix task on the feature branch: `task_provision base=<feature>` with a spec naming the reviewer's findings, then the truest path (`tmb_planning` §6: `review_handoff`, code-reviewer, `bro_atomic_close` after its pass), then `feature-merge` and the backup push as in "Agile review mode" step 3. Once the fix has landed, hand the failed group off again at the new tip, adding the fix task when `review_queue` lists it; the fix task's own pass never batch-reviews the group.
6. **Waive on the Human's word.** When the Human wants to merge without the grouped review, ask one AskUserQuestion naming `<feature>` and its queued tasks. Only on Yes, call `review_waive_record(agent='bro', feature_branch=<feature>, human_answer=<the answer, verbatim>)`; it waives only the tasks queued on the branch at that moment, at their current commits. A task queued later, or one whose commit moves, is not covered and needs the grouped review or a new waiver.
7. **Open the PR.** Once no task of `<feature>` is queued, check for a remote with `git -C <repo path> remote get-url origin`. When it fails, tell the Human `<feature>` is ready to merge locally, as in Outcomes. With origin, `git -C <repo path> push origin <feature>`, then `gh pr create -R <slug> --head <feature> --base <pr_target>` / `glab mr create -R <slug> --source-branch <feature> --target-branch <pr_target>`, and surface the URL; the merge gate denies the PR while a task of `<feature>` is still queued.
8. **Clean up after the merge.** Once `gh pr view <n> -R <slug> --json state` reports `MERGED` (`glab mr view <n> -R <slug> --output json` reports `merged`), or with no remote once the Human says the local merge is done, remove any task worktree still on `<feature>` as in Post-merge cleanup, then run `<feature-branch> cleanup <feature> --repo <repo>`, which deletes the local `<feature>`. Exit 4 means `<feature>` is still checked out in a worktree, or `origin/<feature>` still exists after its fetch. Switch a worktree off `<feature>` yourself; a remote copy the merge left behind is the Human's call, so surface the stderr to them. Rerun once the cause is gone.

**Drop on the Human's word.** When the Human abandons `<feature>`, run `<feature-branch> drop <feature> --repo <repo>`. It cancels the branch's queued tasks (`escalated`, with the dropped branch as the cause) and keeps the branch; add `--delete-branch` only when the Human explicitly says to delete the branch too. Exit 4 writes nothing: a task on the branch is still pending, running, needs_validation or completed, or the branch is unknown. Settle each live task with the Human first, then rerun.
