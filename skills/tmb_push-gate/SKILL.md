---
name: tmb_push-gate
description: How bro handles `git push` blocked by the pre-push hook — query unsigned tasks, spawn pr-reviewer in parallel for each, surface pass/fail to Human. The push gate is bro's only pr-reviewer interaction; reviewer never fires per-task. Loaded when Human says "review before push" or hook blocks push.
agent: bro
allowed-tools: Task, Bash, mcp__plugin_tmb_trajectory-server__task_get, mcp__plugin_tmb_trajectory-server__validation_history
---

# push-gate

## Purpose

PR-Reviewer is **the push gate**, not a per-task reviewer. It runs only at `git push` time, over a batch of unsigned tasks, so its cost is amortized. Bro alone gates each individual task at close (via `bro_verification_pass` ledger event); pr-reviewer's deeper review fires only when commits are about to leave the developer's machine.

## When invoked

Two triggers:

1. The pre-push hook (`scripts/hooks/git-push-guard.sh`) blocks a `git push` because one or more commits being pushed correspond to tasks without a `validation_attempts.verdict='pass'` row. The hook's message:

   > BLOCKED: pushing N unsigned commits. Run `@bro review before push` to get pr-reviewer sign-off.

2. The Human says `@bro review before push` (or any phrase containing "review before push").

## Protocol

1. **Reap each unsigned task's detached-HEAD worktree commits into the local feature branch.** For each unsigned task, look up `tasks.branch_id` and the slug, then from the main checkout:
   ```bash
   git fetch ./.claude/worktrees/<slug> HEAD:<branch_id>
   ```
   This fast-forwards the local branch ref to the worktree's detached HEAD. The branch now reflects the work; the worktree's commits are preserved.
2. **Query MCP** for tasks with `commit_sha NOT NULL` AND no passing `validation_attempts.verdict='pass'` row. These are the unsigned-task batch.
3. **For each task in the batch, spawn `pr-reviewer`** with `task_id=N`. Run them in parallel where possible — they're independent.
   - `pr-reviewer` ships globally with the plugin. **No file copy needed.** CC's agent dispatcher discovers it automatically.
4. **Each pr-reviewer signs off** with `validation_record(verdict='pass'|'fail', ...)`.
5. **On all-pass:** push the local branch (`git push origin <feature>`), open the MR, then tell the Human the gate is clear. After the MR merges, run the **Post-merge cleanup** below.
6. **On any fail:** surface the failure verbatim. The Human chooses:
   - Accept the fix scope → bro spawns swe to address.
   - Abort the push.

## Post-merge cleanup

After the MR merges (whether bro or Human merges it):

1. Switch the main checkout back to the configured base: `git switch <base>` (where `<base>` is the value of `pr_target` from `config_get`).
2. Fast-forward the base: `git pull --ff-only`.
3. Delete the now-merged feature branch locally: `git branch -d <feature>`.
4. Cleanup hook removes the SWE worktree on task close (no manual action needed).

## Why this design

- pr-reviewer is heavy (full diff read + skill loading + verdict authoring). Per-task review would multiply that cost by the task count.
- The push moment is the natural batch boundary — Human is already pausing to ship.
- Bro's task-gate verification (`bro_verification_pass`) is the lighter always-on check; pr-reviewer is the deeper occasional check.

## Never

- Spawn pr-reviewer at task close. That's bro's job (verification + ledger event).
- Spawn pr-reviewer outside the push gate. There's no other moment it should fire.
- Skip a pr-reviewer fail because "the push is urgent". Either accept the fix or abort. Surfacing-and-shipping-anyway corrupts the audit trail.
