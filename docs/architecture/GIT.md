# Git workflow — actor states across a task lifecycle

Where each actor's git state lives at every stage of a TMB task: "what branch am I on?", "what is bro looking at?", "where did swe put the work?". The guards that enforce it are the git hooks under `mcp/trajectory-server/src/hooks/`; the task chain they serve is flow 2 in [`FLOWS.md`](./FLOWS.md), at design level.

## Core principle: local is canonical, origin is downstream

Your local `<feature>` branch is the source of truth at every step of a task. swe's commits land directly on `<feature>` — its worktree owns the branch ref — and the branch then flows out to origin through bro's push. swe never pushes, so nothing reaches origin without passing bro's checks and the code-reviewer.

This mirrors the standard developer flow: edit and commit locally, push, open a PR. The TMB twist is that "edit and commit" happens in swe's worktree, attached directly to `<feature>`, so its commits advance the branch ref with no separate merge step. Integration into `<base>` happens on the remote when the PR merges.

## Actors

- **You** — your shell and IDE on the project's main checkout.
- **Bro** — the persona on the main Claude thread. Works on the main checkout, which stays on `<base>`.
- **swe** — subagent. Works only in a private worktree under `<project>/.claude/worktrees/`, attached to `<feature>`.
- **Origin** — your remote. `<base>` is the repo's configured PR target, held on its `repos` row.

## Stage table

| Actor | Idle | Task provisioned | swe working | swe committed | Bro pushes (PR opens) | After merge |
|---|---|---|---|---|---|---|
| **You** + **Bro** (main checkout) | `<base>` | `<base>` — bro provisions the task, its `<feature>` branch from `origin/<base>` and its worktree, without switching the main checkout | `<base>` | `<base>` | `<base>`; bro pushes `<feature>`, already advanced by swe's commits | `<base>` |
| **swe** | not spawned | not spawned | worktree on `<feature>`, dirty edits | worktree on `<feature>` with commits that advance the local ref | idle; the worktree stays for review rework | worktree removed; branch ref freed |
| **Origin** | `<base>` | `<base>` | same | same — swe has not pushed | `<feature>` updated by bro's push | `<base>` advanced; `<feature>` deleted if the host removes merged branches |

## Key handoffs

- **Bro provisions the task and its worktree.** One provisioning call creates the task, cuts `<feature>` from `origin/<base>` and attaches a worktree to it. The main checkout never switches branches. swe never creates branches or worktrees.
- **No bro-side merge.** swe's commits are already on `<feature>`, so bro just pushes it.
- **Push gate.** A push is admitted only when each pushed task commit has a passing code-reviewer verdict.
- **Cleanup.** A passing review of the closed task removes its worktree; a merge run in the session also removes the merged local branch.

## Why this design

A git branch can be checked out in only one worktree at a time. swe's worktree owns `<feature>` while swe works, and the main checkout sits on `<base>` for the whole task, so there is never a second checkout to reconcile.

Routing swe's commits through your local branch, rather than letting swe push to origin, keeps the standard mental model: local commits, then push, then PR. You can inspect, rebase, drop or amend before anything reaches origin.

## Per-repo branch policy and guard scoping

Branch policy is **per repo**. Each registered repo's `repos` row carries its PR target, branching model and protected branches, and is the sole source of truth; there is no global fallback. The git guards resolve the acting repo from the command's git toplevel and enforce that row's policy.

`/scan` is the registration point. See [`REPO_RESOLUTION.md`](./REPO_RESOLUTION.md).

## Rebasing a reviewed task

swe never fetches, rebases or pulls. When `<base>` moves after a task passed review, bro runs the server CLI's `integrate` subcommand (`mcp/trajectory-server/src/cli/integrate.ts`) from the main checkout. It rebases the reviewed commit in a temporary worktree, refuses when the rebased patch differs from the reviewed one or conflicts, re-runs the task's verification on the result, and only on a pass moves the task branch and the task's recorded commit to the rebased SHA. Because the patch is unchanged, the reviewed commit's pass carries over to the rebase, the way Gerrit carries a vote across a trivial rebase; any other new commit needs a fresh review. The push gate applies the same patch-identity rule to rebased commits no task records.

## Where files live

| Path | Belongs to | Lifetime |
|---|---|---|
| `<project>/` (main checkout) | You + bro | Permanent; stays on `<base>` |
| `<project>/.claude/worktrees/<slug>/` | swe, on the task's `<feature>` | Per task; created at provisioning, removed once the task is reviewed or merged |
| `origin/<base>` | Shared | Permanent; advances on merges |
| `origin/<feature>` | Shared | Per task; created by bro's push |
