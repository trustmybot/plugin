# Git workflow

Where each actor's git state lives at every stage of a TMB task, and how a workspace with several repos decides which repo an operation belongs to. [FLOWS.md](./FLOWS.md) shows the task chain this serves, from the Human's ask to the merge.

## Core principle: local is canonical, origin is downstream

Your local `<feature>` branch is the source of truth at every step of a task. swe's commits land directly on `<feature>`, since its worktree owns the branch, and the branch reaches origin only through bro's push. swe never pushes, so nothing reaches origin without passing bro's checks and the code-reviewer.

This is the standard developer flow: commit locally, push, open a PR. The TMB twist is that the commits happen in swe's worktree, attached to `<feature>`, so they advance the branch with no separate merge step. Integration into `<base>` happens on the remote when the PR merges.

## Actors and stages

- **You and bro** work on the project's main checkout, which stays on `<base>` for the whole task.
- **swe** works only in a private worktree under the project, attached to `<feature>`.
- **Origin** is your remote; `<base>` is the repo's configured PR target.

| Actor | Idle | Task provisioned | swe working | swe committed | Bro pushes (PR opens) | After merge |
|---|---|---|---|---|---|---|
| **You + bro** | `<base>` | `<base>`; bro cuts `<feature>` from `origin/<base>` and attaches a worktree, without switching | `<base>` | `<base>` | `<base>`; bro pushes `<feature>` | `<base>` |
| **swe** | not spawned | not spawned | worktree on `<feature>`, dirty | worktree on `<feature>`, commits advance it | idle; worktree kept for rework | worktree removed |
| **Origin** | `<base>` | `<base>` | same | same | `<feature>` updated | `<base>` advanced |

## Key handoffs

- **Bro provisions.** One step creates the task, cuts `<feature>` from `origin/<base>` and attaches a worktree. The main checkout never switches branches; swe never creates branches or worktrees.
- **No bro-side merge.** swe's commits are already on `<feature>`, so bro just pushes it.
- **Push gate.** A push is admitted only when every pushed task commit has a passing code-reviewer verdict.
- **Cleanup.** A passing review removes the task's worktree; a merge in the session also removes the merged local branch.

## Why this design

A branch can be checked out in only one worktree at a time. swe's worktree owns `<feature>` while swe works, and the main checkout sits on `<base>` throughout, so there is never a second checkout to reconcile.

Routing swe's commits through your local branch, rather than letting swe push, keeps the usual mental model: you can inspect, rebase or drop anything before it reaches origin.

## Rebasing a reviewed task

swe never fetches, rebases or pulls. When `<base>` moves after a task passed review, bro rebases the reviewed commit in a scratch worktree, refuses when the rebased patch differs from the reviewed one or conflicts, and re-runs the task's verification on the result. Only on a pass do the branch and the task's recorded commit move to the rebased commit. Because the patch is unchanged, the review carries over, the way Gerrit carries a vote across a trivial rebase; any other new commit needs a fresh review. The push gate applies the same patch-identity rule to rebased commits no task records.

## Multi-repo workspaces

A workspace can hold several inner git repos, siblings or submodules, under one trajectory DB. TMB resolves "which repo does this operation belong to" by **path**, never by a global default repo:

1. **Repos are identified by registration.** A repo takes part in TMB only once `/scan` has registered it. Registration is the same step that warms the world model, so the two stay aligned.
2. **Resolution is path-keyed.** An operation belongs to the registered repo whose path contains it: the command's git root for a hook, the task's repo for a task. World-model paths are stored relative to their repo.
3. **Branch policy is per repo.** Each repo's PR target, branching model and protected branches are recorded with its registration and nowhere else; there is no global fallback. The git guards enforce the policy of the repo the command runs in.
4. **Single-repo fallback.** When an operation names no repo and exactly one is registered, it resolves to that repo, so single-repo projects need no repo argument anywhere.

A global default repo would force one repo to be "the" repo and make the guards guess what to enforce; it breaks as soon as a second repo joins. Path-keyed resolution lets sibling repos coexist with none privileged.
