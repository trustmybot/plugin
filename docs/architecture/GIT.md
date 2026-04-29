# Git workflow — actor states across a task lifecycle

Where each actor's git state lives at every stage of a TMB self-dev task. Helps you answer "what branch am I on?" / "what is bro looking at?" / "where did SWE put the work?" without spelunking.

> **Implementation status:** the model below is the intended workflow. The current SWE doctrine still creates a branch-held worktree (which blocks the Human's main checkout from following the feature branch). Issue #126 tracks the alignment work — when it lands, this doc will match the running code.

## Actors

- **You** — your shell + IDE on `plugin/` (the main checkout)
- **Bro** — the persona on the main Claude thread. Operates on the main checkout via `git -C plugin …`.
- **SWE** — subagent. Always works from a private worktree at `plugin/.claude/worktrees/<slug>/`, in **detached HEAD**, never holding the branch ref.
- **Origin** — `origin/dev` and any feature branches on GitLab.

## Stage table

| Actor | Idle | Issue + task filed, branch pre-created | SWE working | SWE pushed (MR open) | Push gate / bro verify | After merge |
|---|---|---|---|---|---|---|
| **You** + **Bro** (`plugin/` main) | `dev` | `<feature>` — bro creates the branch from `origin/dev` and switches the main checkout to it | `<feature>` (run `git fetch && git merge --ff-only origin/<feature>` to see SWE's commits as they land) | `<feature>` (fast-forwarded after fetch) | `<feature>` | `dev` — bro switches back and `git pull --ff-only` |
| **SWE** | not spawned | not spawned | `.claude/worktrees/<slug>/` in **detached HEAD** off `<feature>`; commits to detached HEAD; pushes via `git push origin HEAD:refs/heads/<feature>` | (idle, worktree still around) | (idle) | worktree removed |
| **Origin** | `dev` | `dev` | same | `dev`; `<feature>` updated by SWE's push | same | `dev` advanced (merge commit + feature commits); `<feature>` removed (`--remove-source-branch`) |

## Key handoffs

- **Bro pre-creates the branch from `origin/dev` AND switches the main checkout to it.** This is what makes the feature branch live in the main checkout — so You and Bro share the same view.
- **SWE never holds a branch ref.** The worktree is created with `git worktree add --detach`, so the `<feature>` ref stays free for the main checkout. SWE commits to detached HEAD and pushes via `HEAD:refs/heads/<feature>`.
- **You see SWE's commits after each fetch.** While SWE works, your main checkout doesn't auto-update; run `git fetch && git merge --ff-only origin/<feature>` (or just `git pull --ff-only`) to pull each push as it lands.
- **After merge, bro switches the main checkout back to `dev`.** No manual cleanup on your side.

## Why detached HEAD for SWE

A git branch can only be checked out in one worktree at a time. If SWE's worktree held the `<feature>` ref, your main checkout couldn't switch to it — exactly the bug in #126. Detaching HEAD in SWE's worktree decouples the worktree from the branch ref: SWE commits go to detached HEAD, and `git push origin HEAD:refs/heads/<feature>` updates the remote branch directly. The local branch ref (held by main checkout) catches up via `git fetch` + fast-forward.

## Where files live, at a glance

| Path | Belongs to | Lifetime |
|---|---|---|
| `plugin/` (main checkout) | You + bro | Permanent; switches between `dev` and `<feature>` per task |
| `plugin/.claude/worktrees/<slug>/` | SWE (detached HEAD) | Per-task; created on spawn, removed after merge |
| `origin/dev` | Shared | Permanent; advances on merges |
| `origin/<type>/<slug>` | Shared | Per-task; removed by `glab mr merge --remove-source-branch` |
