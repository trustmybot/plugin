# Git workflow — actor states across a task lifecycle

Where each actor's git state lives at every stage of a TMB task. Helps you answer "what branch am I on?" / "what is bro looking at?" / "where did SWE put the work?" without spelunking.

## Core principle: local is canonical, origin is downstream

Your local `<feature>` branch is the source of truth at every step of a task. SWE's commits flow INTO the local branch (via merge), then the local branch flows OUT to origin (via push). SWE never pushes straight to origin — that would bypass the local-canonical invariant and your review.

This mirrors standard developer flow: edit + commit locally, push to origin, open PR. The TMB twist is that "edit + commit" happens in SWE's worktree, then bro merges those commits into the local branch before push.

## Actors

- **You** — your shell + IDE on your project's main checkout
- **Bro** — the persona on the main Claude thread. Operates on the main checkout via `git -C <project> …`.
- **SWE** — subagent. Always works from a private worktree at `<project>/.claude/worktrees/<slug>/`, in **detached HEAD**, never holding the branch ref.
- **Origin** — your remote. `<base>` is the configured base branch (`main` for github-flow, `dev` for gitflow — set via the `pr_target` plugin config).

## Stage table

| Actor | Idle | Issue + task filed, branch pre-created | SWE working | SWE committed (in worktree) | Bro merges + pushes (MR opens) | Push gate / verify | After merge |
|---|---|---|---|---|---|---|---|
| **You** + **Bro** (main checkout) | `<base>` | `<feature>` — bro creates the branch from `origin/<base>` and switches the main checkout to it | `<feature>` (no SWE commits yet) | `<feature>` (still no SWE commits — SWE's work lives only in the detached worktree until bro merges) | `<feature>` advanced to include SWE's commits via `git fetch ./.claude/worktrees/<slug> HEAD:<feature>`; then `git push origin <feature>` | `<feature>` | `<base>` — bro switches back and `git pull --ff-only` |
| **SWE** | not spawned | not spawned | `.claude/worktrees/<slug>/` in **detached HEAD** off `<feature>`; dirty edits | `.claude/worktrees/<slug>/` in detached HEAD with one or more commits, NOT pushed | (idle, worktree still around for inspection) | (idle) | worktree removed |
| **Origin** | `<base>` | `<base>` only | same | same — SWE has not pushed | `<base>`; `<feature>` updated by bro's push from local | same | `<base>` advanced (merge commit + feature commits); `<feature>` removed (`--remove-source-branch`) |

## Key handoffs

- **Bro pre-creates the branch from `origin/<base>` AND switches the main checkout to it.** The feature branch lives in the main checkout — You and Bro share the same view.
- **SWE never holds a branch ref and never pushes.** The worktree is created with `git worktree add --detach`, so the `<feature>` ref stays free for the main checkout. SWE commits to detached HEAD; bro pulls those commits into the local `<feature>` branch.
- **Bro merges SWE's worktree commits into the local feature branch** with `git fetch ./.claude/worktrees/<slug> HEAD:<feature>` (fast-forwards the local ref to SWE's HEAD). This is the moment the work becomes "yours" on your local branch.
- **Bro pushes the LOCAL `<feature>` to origin** with a normal `git push origin <feature>`. Origin mirrors local. No detached-HEAD push tricks needed.
- **After MR merge, bro switches the main checkout back to `<base>`** and pulls.

## Why this design

A git branch can only be checked out in one worktree at a time. If SWE's worktree held the `<feature>` ref, your main checkout couldn't switch to it. Detaching HEAD in SWE's worktree decouples the worktree from the branch ref so the main checkout owns the ref.

Routing SWE's commits through your local branch (rather than letting SWE push straight to origin) preserves the standard developer mental model: local commits → push → PR. Your local branch is always canonical; you can inspect, rebase, drop, or amend before anything reaches origin. Industry-standard PR flows assume this — bypassing it (CI bots that push straight to feature branches) is the unusual pattern that most teams disallow.

## Where files live, at a glance

| Path | Belongs to | Lifetime |
|---|---|---|
| `<project>/` (main checkout) | You + bro | Permanent; switches between `<base>` and `<feature>` per task |
| `<project>/.claude/worktrees/<slug>/` | SWE (detached HEAD) | Per-task; created on spawn, removed after bro merges its commits into local `<feature>` |
| `origin/<base>` | Shared | Permanent; advances on merges |
| `origin/<feature>` | Shared | Per-task; created by bro's push from local; removed after MR merge |

## Realized by — files per stage

**Idle**
```text
plugin/
├── CLAUDE.md                                          # bro persona; reads identity + issue_resume on activation
├── scripts/hooks/activation-routine.sh               # UserPromptSubmit: pre-fetches identity + pending issue
└── mcp/trajectory-server/src/
    ├── tools/identity.ts                             # identity_get
    ├── tools/issues.ts                               # issue_resume
    └── schema.sql                                    # plugin_config defaults seeded at DB init
```

**Issue + task filed, branch pre-created**
```text
plugin/
├── CLAUDE.md                                          # bro planning chain (issue_create → task_create_batch)
├── skills/
│   ├── tmb_planning-simple/SKILL.md                  # simple triage plan
│   ├── tmb_planning-difficult/SKILL.md               # difficult triage plan + ADR
│   └── tmb_branch-id-proposal/SKILL.md               # proposes the feature branch slug
├── scripts/hooks/
│   ├── git-guards.sh                                 # enforces branch naming on commits
│   └── require-feature-branch-active.sh              # blocks issue/task ops without a feature branch
└── mcp/trajectory-server/src/tools/
    ├── issues.ts                                     # issue_create
    ├── tasks.ts                                      # task_create_batch
    ├── discussions.ts                                # discussion_append (intent + triage note)
    └── ledger.ts                                     # ledger_log (planning_complete)
```

**SWE working**
```text
plugin/
├── agents/swe.md                                      # SWE executor prompt
├── scripts/hooks/
│   ├── require-task-spec.sh                          # gates spawn on valid pending spec row
│   ├── worktree-create.sh                            # creates the detached worktree on spawn
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
│   ├── require-summaries-before-task-close.sh        # blocks close if file summaries missing
│   └── cleanup-worktree-on-task-close.sh             # removes worktree after bro closes task
└── mcp/trajectory-server/src/tools/
    ├── tasks.ts                                      # task_update_status(completed, commit_sha)
    └── file-registry.ts                              # file_registry_update_summaries
```

**Bro merges + pushes (MR opens)**
```text
plugin/
├── CLAUDE.md                                          # bro verification protocol (V1/V2/V3)
├── skills/tmb_push-gate/SKILL.md                     # push-gate orchestration
├── scripts/hooks/
│   ├── git-push-guard.sh                             # blocks push without pass verdicts
│   └── branch-up-to-date-with-remote.sh              # verifies local branch is current
└── mcp/trajectory-server/src/tools/
    ├── tasks.ts                                      # task_update_status(closed) by bro
    ├── ledger.ts                                     # ledger_log(bro_verification_pass)
    ├── file-registry.ts                              # file_registry_update_summaries (advance sha)
    └── issues.ts                                     # issue_close
```

**Push gate / verify**
```text
plugin/
├── agents/pr-reviewer.md                             # pr-reviewer subagent
├── skills/
│   ├── tmb_push-gate/SKILL.md                        # bro push-gate orchestration
│   ├── tmb_review-protocol/SKILL.md                  # reviewer phases 1-7
│   ├── tmb_review-findings/SKILL.md                  # pattern catalog
│   └── tmb_code-quality/SKILL.md                     # shared quality criteria
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
    ├── ledger.ts                                     # ledger_log (post-merge state)
    └── regen-state.ts                                # regen_state_update after merge contents
```
