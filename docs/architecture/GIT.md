# Git workflow — actor states across a task lifecycle

Where each actor's git state lives at every stage of a TMB task. Helps you answer "what branch am I on?" / "what is bro looking at?" / "where did SWE put the work?" without spelunking.

## Core principle: local is canonical, origin is downstream

Your local `<feature>` branch is the source of truth at every step of a task. SWE's commits land directly on `<feature>` — its worktree owns the branch ref — then the branch flows OUT to origin (via push). SWE never pushes straight to origin — that would bypass the local-canonical invariant and your review.

This mirrors standard developer flow: edit + commit locally, push to origin, open PR. The TMB twist is that "edit + commit" happens in SWE's worktree, which is attached directly to `<feature>` — so its commits advance the branch ref with no separate bro-side merge. Bro just pushes `<feature>` and opens the PR/MR; integration into `<base>` happens on the remote when the PR merges.

## Actors

- **You** — your shell + IDE on your project's main checkout
- **Bro** — the persona on the main Claude thread. Operates on the main checkout via `git -C <project> …`.
- **SWE** — subagent. Always works from a private worktree at `<project>/.claude/worktrees/<slug>/`, attached directly to `<feature>` so commits advance the branch ref naturally.
- **Origin** — your remote. `<base>` is the configured base branch (`main` for github-flow, `dev` for gitflow — set via the `pr_target` plugin config).

## Stage table

| Actor | Idle | Issue + task filed, branch pre-created | SWE working | SWE committed (in worktree) | Bro pushes (MR opens) | Push gate / verify | After merge |
|---|---|---|---|---|---|---|---|
| **You** + **Bro** (main checkout) | `<base>` | `<base>` — bro creates `<feature>` from `origin/<base>` but DOES NOT switch the main checkout to it (SWE's worktree will own the branch ref) | `<base>` | `<base>` | `<base>`; bro runs `git -C <project> push origin <feature>` (the ref is already ahead via SWE's commits in the worktree) | `<base>` | `<base>` — origin/`<feature>` is gone after merge |
| **SWE** | not spawned | not spawned | `.claude/worktrees/<slug>/` checked out on `<feature>`; dirty edits | `.claude/worktrees/<slug>/` on `<feature>` with one or more commits — these commits ADVANCE the local `<feature>` ref directly because the worktree holds it | (idle, worktree still around for inspection) | (idle) | worktree removed; branch ref freed |
| **Origin** | `<base>` | `<base>` only | same | same — SWE has not pushed | `<base>`; `<feature>` updated by bro's push from the local ref (which SWE's worktree already advanced) | same | `<base>` advanced (merge commit + feature commits); `<feature>` removed (`--remove-source-branch`) |

## Key handoffs

- **Bro pre-creates the branch from `origin/<base>` but stays on `<base>`.** Bro creates `<feature>` via `git -C <project> branch <feature> origin/<base>` (or equivalent) without checking it out. SWE's worktree will own the branch ref next.
- **SWE's worktree attaches to `<feature>` directly.** `git -C <repo> worktree add <path> <feature>`. SWE's commits advance the branch ref naturally; pushes carry the work without a separate merge step.
- **No bro-side merge step.** Because SWE's commits already landed on `<feature>`, bro just pushes: `git -C <project> push origin <feature>`. Origin mirrors the local `<feature>` ref, which already includes SWE's work.
- **After MR merge**, bro removes the worktree (which frees the ref) and the branch is gone from origin via `--remove-source-branch`.

## Why this design

A git branch can only be checked out in one worktree at a time. SWE's worktree owns `<feature>` so its commits advance the branch ref directly — pushes carry the work via the branch ref alone, with the main checkout sitting on `<base>` for the duration of the task. The single-owner rule of git worktrees is what makes this work: ownership of `<feature>` belongs to one place at a time (SWE's worktree while SWE works; the main checkout after the worktree is removed), so there's never a second checkout to reconcile against.

Routing SWE's commits through your local branch (rather than letting SWE push straight to origin) preserves the standard developer mental model: local commits → push → PR. Your local branch is always canonical; you can inspect, rebase, drop, or amend before anything reaches origin. Industry-standard PR flows assume this — bypassing it (CI bots that push straight to feature branches) is the unusual pattern that most teams disallow.

## Per-repo branch protection + guard scoping

Branch policy is **per-repo**, not global. Each registered repo's `repos` row carries its own `target_branch`, `branching_model`, and `protected_branches`; the git guards resolve the acting repo path-keyed (the command's git toplevel → matching `repos` row) and enforce that row's policy. The `repos` row is the sole source of truth — there is no global `plugin_config` fallback.

Guard scoping is **registration-based**: a git op is enforced only when its git-root resolves to a registered `repos` row. When the command's git-root is an unregistered sibling tree, the guards no-op — TMB never enforces on a tree it doesn't manage. For a single-repo project the sole repo is the registered root, so the whole tree is guarded; `/scan` is the registration point. See [`REPO_RESOLUTION.md`](./REPO_RESOLUTION.md) for the full resolution contract.

## Where files live, at a glance

| Path | Belongs to | Lifetime |
|---|---|---|
| `<project>/` (main checkout) | You + bro | Permanent; switches between `<base>` and `<feature>` per task |
| `<project>/.claude/worktrees/<slug>/` | SWE (on the task's `<feature>` branch) | Per-task; created on spawn, removed after bro closes the task (its commits are already on `<feature>` via the shared branch ref) |
| `origin/<base>` | Shared | Permanent; advances on merges |
| `origin/<feature>` | Shared | Per-task; created by bro's push from local; removed after MR merge |

## dev→main promotion policy

When `dev` is ready to ship, the release PR is merged into `main` using a **merge commit** (`gh pr merge --merge`). This preserves both branches' full ancestry in the graph.

### Why merge commit, not squash

Squash promotions rewrite `main`'s tree without ancestry: every release appears as a single flat commit with no connection to the feature commits that composed it. In practice this caused two compounding problems:

1. **Version-manifest conflicts at every release.** Because `dev`'s history was not represented in `main`'s ancestry, Git could not find a meaningful common ancestor when computing diffs for the next promotion. Files that changed only on `main` (e.g. `plugin.json` version bumps from a hotfix) were treated as divergent on every subsequent release PR.
2. **Main-only file deletion at v0.7.0.** A squash promotion replaced `main`'s tree with `dev`'s snapshot, silently deleting files that existed on `main` but had never been on `dev`. This was the failure mode that prompted the policy change (#472/#473).

Merge commits avoid both: `main` gains ancestry over every `dev` commit, so the common ancestor at the next promotion is real and conflicts reflect genuine content divergence.

### Transition note

`main`'s history prior to v0.8.0 consists of squash-promotions (one flat commit per release). The v0.7.1 release bridged ancestry via an `-s ours` merge (#471), which recorded `dev`'s history into `main`'s graph without altering `main`'s working tree. From v0.8.0 onward, every promotion is a standard merge commit.

## Realized by — files per stage

**Idle**
```text
plugin/
├── CLAUDE.md                                          # bro persona; reads plugin_config('onboarded') + issue_resume on activation
├── scripts/hooks/activation-routine.sh               # UserPromptSubmit: pre-fetches plugin_config('onboarded') + pending issue
└── mcp/trajectory-server/src/
    ├── tools/onboard.ts                              # onboard_state_get (reads plugin_config marker)
    ├── tools/issues.ts                               # issue_resume
    └── schema.sql                                    # plugin_config defaults seeded at DB init
```

**Issue + task filed, branch pre-created**
```text
plugin/
├── CLAUDE.md                                          # bro planning chain (issue_create → task_create_batch)
├── skills/
│   └── tmb_planning/SKILL.md                         # full code-touching flow (spec authoring + SWE spawn + V1/V2/V3)
├── commands/
│   └── scan.md                                       # /scan — must run before task_create_batch (registry-cold gate)
├── scripts/hooks/
│   ├── git-guards.sh                                 # enforces branch naming on commits
│   └── require-feature-branch-active.sh              # blocks issue/task ops without a feature branch
└── mcp/trajectory-server/src/tools/
    ├── issues.ts                                     # issue_create
    ├── tasks.ts                                      # task_create_batch (scope/branch/registry-cold gates)
    ├── discussions.ts                                # discussion_append (intent + decision audit)
    ├── composites.ts                                 # branch_id_propose
    ├── scan.ts                                       # scan_run (Phase 1 of /scan)
    └── audit.ts                                      # audit_append(planning_complete)
```

**SWE working**
```text
plugin/
├── agents/swe.md                                      # SWE executor prompt
├── scripts/hooks/
│   ├── require-task-spec.sh                          # gates spawn on valid pending spec row
│   ├── worktree-create.sh                            # creates the per-task worktree on spawn (on the task's feature branch — see #2879)
│   ├── no-worktree-branch-create.sh                  # prevents SWE from creating branches
│   └── git-guards.sh                                 # commit branch check in worktree
└── mcp/trajectory-server/src/tools/
    ├── tasks.ts                                      # task_get (SWE reads spec) + task_update_status(running)
    └── audit.ts                                      # audit table writes
```

**SWE committed (in worktree)**
```text
plugin/
├── agents/swe.md                                      # atomic close: task_update_status(needs_validation)
├── scripts/hooks/
│   ├── swe-atomic-close.sh                           # SubagentStop safety net if SWE skips close
│   └── cleanup-worktree-on-task-close.sh             # removes worktree after bro closes task
└── mcp/trajectory-server/src/tools/
    └── tasks.ts                                      # task_update_status(completed, commit_sha)
```

**Bro pushes (MR opens)**
```text
plugin/
├── CLAUDE.md                                          # bro verification protocol (V1/V2/V3)
├── skills/tmb_push-gate/SKILL.md                    # bro push-gate orchestration
├── scripts/hooks/
│   ├── git-push-guard.sh                             # blocks push without pass verdicts
│   ├── branch-up-to-date-with-remote.sh              # verifies local branch is current
│   └── post-task-close-rescan.sh                     # PostToolUse: backgrounds /scan to refresh the world model
└── mcp/trajectory-server/src/tools/
    ├── composites.ts                                 # bro_atomic_close (audit + status + close in one txn)
    ├── audit.ts                                      # audit_append(bro_verification_pass)
    └── issues.ts                                     # issue_close
```

**Push gate / verify**
```text
plugin/
├── agents/pr-reviewer.md                             # pr-reviewer subagent
├── skills/tmb_review/SKILL.md                        # pr-reviewer diff-level review protocol
├── skills/tmb_push-gate/SKILL.md                    # bro push-gate orchestration
├── scripts/hooks/git-push-guard.sh                   # final enforcement before origin push
└── mcp/trajectory-server/src/
    ├── tools/validation.ts                           # validation_record (verdict write)
    ├── tools/tasks.ts                                # task_get (read spec + commit_sha)
    ├── tools/discussions.ts                          # discussion_append on FAIL
    └── schema.sql                                    # validation_attempts table
```

**After merge**
```text
plugin/
├── CLAUDE.md                                          # bro post-merge cleanup chain
├── scripts/hooks/cleanup-worktree-on-task-close.sh   # removes SWE worktree (already done at close)
├── scripts/maintenance/cleanup-stale-worktrees.sh    # periodic stale worktree GC
└── mcp/trajectory-server/src/tools/
    ├── audit.ts                                      # audit_append(post-merge state)
    └── scan.ts                                       # scan_run rerun via post-task-close-rescan hook refreshes the world model + emits deep_scan_completed audit
```
