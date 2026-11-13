# Agent responsibilities

What each plugin-shipped agent is for, what it may and may not do, and why the roles are split this way. Each agent's exact tools, skills and model settings sit in its own prompt file; the server's role checks sit in the code. Ask the world model for either.

## Why three roles

The roles are split by what each can be trusted to do without marking its own homework, and by which one survives when something unexpected fires:

- **bro**, the persona on the main thread, holds the full picture: the system design and alignment with the Human. It has the widest permissions, does everything except coding, is the only agent that talks to the Human, and owns every workflow state change.
- **swe** codes, split out for three reasons:
  1. **Token cost.** Coding in bro would fill its strategic context with diff noise.
  2. **No self-homework.** A gate runs the spec's checks on swe's commit, and review refuses a commit without a passing recorded run. The agent that writes the code does not sign it off.
  3. **Subagents are fragile.** swe runs with a narrow tool allowlist and a fresh context, and a hook deny or server error can end its run. Critical state writes stay with bro, the most permissioned and most resilient layer.
- **code-reviewer** is an independent third party at the push gate, with no edit tools. Its verdict is the only one the push gate accepts.

Each layer owns one level of quality, and no layer repeats another's check: the Human owns intent, bro the environment, spec and architecture, swe functionality, and code-reviewer the diff. [FLOWS.md](FLOWS.md#quality-layers) shows how the layers fit together and which wins when a prompt and a hook disagree.

## Which agents a project has

- **Workflow backbone, always available.** swe and code-reviewer ship with the plugin and need no setup. A project-local copy of either, when present, wins over the shipped one.
- **Consultants, opt-in per project.** No named consultant ships. `/tmb:agent-create` drafts one per project from a template, and the project-local file serves it from then on.

An agent's prompt file is its identity, its skills are its added capabilities, and the spawn prompt is the task context. A "more skilled swe" is the same swe with more skills, not a different swe.

## bro

The persona comes from the plugin's `CLAUDE.md`, delivered by hooks; there is no bro agent file.

- **Plans and routes.** Grounds each ask in the trajectory DB and the world model, proposes a branch, writes the task spec, and provisions the task with its branch and worktree.
- **Gates tasks.** When swe returns, bro hands the commit to review and spawns code-reviewer. After a pass it judges only the architecture fit and swe's extra paths, re-running no checks and re-reviewing no diff, then closes the task in one transaction.
- **Gates pushes.** It reads the verdict from its recorded row, never from reply text, rebases onto the base when it moved, pushes and opens the PR.
- **Never edits source.** Every code change goes through swe; hooks deny bro's edits to registered repo source from the main checkout. Unregistered sibling repos are outside that guard; [GIT.md](GIT.md#multi-repo-workspaces) explains how a workspace with several repos decides which ones are registered.
- **Talks to the Human.** Only bro asks the Human questions and reports to them.

## swe

- **Spawned for one provisioned task.** A spawn gate refuses a spawn without one. swe arrives in the task's worktree and reads its brief first.
- **Works in the worktree only.** It edits, tests and commits on the task branch. It never creates branches or worktrees, never fetches, rebases or pushes, and never edits outside its worktree unless the task allows it.
- **Closes with a typed report.** Each success criterion with its evidence, every path edited outside the task's declared files with a reason, and the review findings it fixed. The verification gate runs the spec's checks before the completion is accepted.
- **Stops on a hook block.** A deny is a hard stop: swe retries in the form the deny names, or closes failed and quotes the hook to bro.
- **Hands back.** When the work will not fit its turns, it commits and returns a checkpoint so the next run resumes.

Scope is recorded at the review handoff and judged at close: bro either has the extra paths reverted through swe or accepts them with a recorded reason. code-reviewer reads that record instead of recomputing it.

## code-reviewer

- **One reviewer per completed task,** spawned after the review handoff and before the close, with the task's anchors only; a preflight hook checks them before the reviewer runs.
- **Reviews from the records.** It reads the brief, the recorded verification run and the scope record, re-runs none of swe's checks, and spends the review on its own probes of what the diff's dependents rely on.
- **Signs off with a typed verdict.** The server derives the reviewer's identity itself and refuses a verdict not independent of the swe that wrote the commit.
- **Never edits files** and never changes task status.

## Consultants

- **Cannot write workflow state.** The server refuses their issue, task, status and verdict writes.
- **Write analyses** as discussion rows.
- **Advise, never decide.** bro reports their analysis to the Human, and the Human decides.

## How roles are enforced

Every server tool declares which roles may call it. A hook compares the role a caller claims with its real agent type, or bro for the main session, and denies a mismatch, so a subagent cannot act as bro and the main session cannot act as a subagent. The role-by-tool matrix lives in the code, and each agent's tool allowlist in its prompt file.
