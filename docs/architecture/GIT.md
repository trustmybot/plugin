# Git workflow — actor states across a task lifecycle

Where each actor's git state lives at every stage of a TMB task. Helps you answer "what branch am I on?" / "what is bro looking at?" / "where did SWE put the work?" without spelunking.

## Core principle: local is canonical, origin is downstream

Your local `<feature>` branch is the source of truth at every step of a task. SWE's commits flow INTO the local branch (via merge), then the local branch flows OUT to origin (via push). SWE never pushes straight to origin — that would bypass the local-canonical invariant and your review.

This mirrors standard developer flow: edit + commit locally, push to origin, open PR. The TMB twist is that "edit + commit" happens in SWE's worktree, then bro merges those commits into the local branch before push.

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
    └── audit.ts                                      # audit_log(kind='event', planning_complete)
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
    ├── audit.ts                                      # audit_log(kind='event', bro_verification_pass)
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
    ├── audit.ts                                      # audit_log(kind='event', post-merge state)
    └── regen-state.ts                                # regen_state_update after merge contents
```
