# Git workflow — actor states across a task lifecycle

Where each actor's git state lives at every stage of a TMB self-dev task. Helps you answer "what branch am I on?" / "what is bro looking at?" / "where did SWE put the work?" without spelunking.

## Actors

- **You** — your shell + IDE on `plugin/` (the main checkout)
- **Bro** — the persona on the main Claude thread. Operates on the main checkout via `git -C plugin …`. May create a verification worktree under `/tmp/`.
- **SWE** — subagent. Always works from a private worktree at `plugin/.claude/worktrees/<slug>/`.
- **Origin** — `origin/dev` and any feature branches on GitLab.

## Stage table

| Actor | Idle | Issue + task filed, branch pre-created | SWE working | SWE committed + pushed (MR open) | Push gate / bro verify | After merge |
|---|---|---|---|---|---|---|
| **You** (`plugin/` main) | `dev` | `dev` (feature ref exists locally but you stay on dev) | `dev` — **cannot `git checkout <feature>` because SWE worktree holds it** (issue #126) | `dev` (still blocked) | `dev` | `dev` (after `git pull`, includes the feature) |
| **Bro** | main checkout on `dev` | main checkout on `dev`; created `<type>/<slug>` ref via `git branch <slug> origin/dev` | main checkout on `dev`; can read SWE worktree files via path | main checkout on `dev`; fetches + diffs `origin/<branch>` | optional second worktree at `/tmp/tmb-XXX-verify` from `origin/<branch>` for a clean diff view | main checkout on `dev`; cleans up worktrees |
| **SWE** | not spawned | not spawned | `.claude/worktrees/<slug>/` on `<type>/<slug>` — dirty edits | `.claude/worktrees/<slug>/` on `<type>/<slug>` — committed | (idle, worktree still around) | worktree cleanup pending per issue #126 |
| **Origin** | `dev` | `dev` only — `<type>/<slug>` not pushed yet | same | `dev`; `<type>/<slug>` now on remote; MR open | same | `dev` advanced (merge commit + feature commits); `<type>/<slug>` removed (`--remove-source-branch`) |

## Key handoffs

- **Bro pre-creates the branch from `origin/dev`** so SWE never invents one. SWE's worktree-add command uses the existing ref.
- **SWE never works in the main checkout.** The `.claude/worktrees/<slug>/` isolation prevents accidental pollution and lets parallel SWEs run on different branches simultaneously.
- **You're always on `dev`** during a task. Your IDE keeps showing dev's content. To inspect in-flight work: `git show origin/<branch>:<path>`, or open `plugin/.claude/worktrees/<slug>/` in a second editor window.
- **Workflow gap (issue #126):** there is currently no clean path for your main checkout to follow the active feature branch — the SWE worktree holds the ref. Three solutions tracked there.

## Where files live, at a glance

| Path | Belongs to | Lifetime |
|---|---|---|
| `plugin/` (main checkout) | You + bro | Permanent; stays on `dev` |
| `plugin/.claude/worktrees/<slug>/` | SWE | Per-task; created on spawn, removed on cleanup (issue #126) |
| `/tmp/tmb-<slug>-verify/` | Bro (verification) | Per-task review; manually removed |
| `origin/dev` | Shared | Permanent; advances on merges |
| `origin/<type>/<slug>` | Shared | Per-task; removed by `glab mr merge --remove-source-branch` |
