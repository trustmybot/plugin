# Git workflow — actor states across a task lifecycle

Where each actor's git state lives at every stage of a TMB self-dev task. Helps you answer "what branch am I on?" / "what is bro looking at?" / "where did SWE put the work?" without spelunking.

> **Implementation status:** the model below is the intended workflow. The current SWE doctrine still creates a branch-held worktree AND pushes directly to origin (which blocks the Human's main checkout from following the feature branch and breaks the local-canonical invariant). Issue #126 tracks the alignment work — when it lands, this doc will match the running code.

## Core principle: local is canonical, origin is downstream

The Human's local `<feature>` branch is the source of truth at every step of a task. SWE's commits flow INTO the local branch (via merge), then the local branch flows OUT to origin (via push). SWE never pushes straight to origin — that would bypass the local-canonical invariant and the Human's review.

This mirrors standard developer flow: edit + commit locally, push to origin, open PR. The TMB twist is that "edit + commit" happens in SWE's worktree, then bro merges those commits into the local branch before push.

## Actors

- **You** — your shell + IDE on `plugin/` (the main checkout)
- **Bro** — the persona on the main Claude thread. Operates on the main checkout via `git -C plugin …`.
- **SWE** — subagent. Always works from a private worktree at `plugin/.claude/worktrees/<slug>/`, in **detached HEAD**, never holding the branch ref.
- **Origin** — `origin/dev` and any feature branches on GitLab.

## Stage table

| Actor | Idle | Issue + task filed, branch pre-created | SWE working | SWE committed (in worktree) | Bro merges + pushes (MR opens) | Push gate / verify | After merge |
|---|---|---|---|---|---|---|---|
| **You** + **Bro** (`plugin/` main) | `dev` | `<feature>` — bro creates the branch from `origin/dev` and switches the main checkout to it | `<feature>` (no SWE commits yet) | `<feature>` (still no SWE commits — SWE's work lives only in the detached worktree until bro merges) | `<feature>` advanced to include SWE's commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`; then `git push origin <feature>` | `<feature>` | `dev` — bro switches back and `git pull --ff-only` |
| **SWE** | not spawned | not spawned | `.claude/worktrees/<slug>/` in **detached HEAD** off `<feature>`; dirty edits | `.claude/worktrees/<slug>/` in detached HEAD with one or more commits, NOT pushed | (idle, worktree still around for inspection) | (idle) | worktree removed |
| **Origin** | `dev` | `dev` only | same | same — SWE has not pushed | `dev`; `<feature>` updated by bro's push from local | same | `dev` advanced (merge commit + feature commits); `<feature>` removed (`--remove-source-branch`) |

## Key handoffs

- **Bro pre-creates the branch from `origin/dev` AND switches the main checkout to it.** The feature branch lives in the main checkout — You and Bro share the same view.
- **SWE never holds a branch ref and never pushes.** The worktree is created with `git worktree add --detach`, so the `<feature>` ref stays free for the main checkout. SWE commits to detached HEAD; bro pulls those commits into the local `<feature>` branch.
- **Bro merges SWE's worktree commits into the local feature branch** with `git fetch ./.claude/worktrees/<slug> HEAD:<feature>` (fast-forwards the local ref to SWE's HEAD). This is the moment the work becomes "yours" on your local branch.
- **Bro pushes the LOCAL `<feature>` to origin** with a normal `git push origin <feature>`. Origin mirrors local. No detached-HEAD push tricks needed.
- **After MR merge, bro switches the main checkout back to `dev`** and pulls.

## Why this design

A git branch can only be checked out in one worktree at a time. If SWE's worktree held the `<feature>` ref, your main checkout couldn't switch to it. Detaching HEAD in SWE's worktree decouples the worktree from the branch ref so the main checkout owns the ref.

Routing SWE's commits through your local branch (rather than letting SWE push straight to origin) preserves the standard developer mental model: local commits → push → PR. Your local branch is always canonical; you can inspect, rebase, drop, or amend before anything reaches origin. Industry-standard PR flows assume this — bypassing it (CI bots that push straight to feature branches) is the unusual pattern that most teams disallow.

## Where files live, at a glance

| Path | Belongs to | Lifetime |
|---|---|---|
| `plugin/` (main checkout) | You + bro | Permanent; switches between `dev` and `<feature>` per task |
| `plugin/.claude/worktrees/<slug>/` | SWE (detached HEAD) | Per-task; created on spawn, removed after bro merges its commits into local `<feature>` |
| `origin/dev` | Shared | Permanent; advances on merges |
| `origin/<type>/<slug>` | Shared | Per-task; created by bro's push from local; removed by `glab mr merge --remove-source-branch` |
