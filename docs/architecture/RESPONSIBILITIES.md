# Agent responsibilities

What each plugin-shipped agent is for, what it may and may not do, and why the roles are split this way. Exact tools, skills and model settings live in each agent's frontmatter (`agents/*.md`, `templates/agents/template.md`); the server-side role checks live in `mcp/trajectory-server/src/` (`requireRoles` in `middleware/agent-scope.ts`, called by each tool family). This page does not repeat them.

## Agent layer model

Two layers determine which agents are available in a project.

**Layer 1 — Workflow backbone (always global):** `swe` and `code-reviewer` ship in the plugin's `agents/` directory and are available without any copy or onboarding step. When bro spawns one, Claude Code dispatches by name: a project-local `.claude/agents/<name>.md` wins if present, the global file is the fallback.

**Layer 2 — Consultants (opt-in per project):** no named consultant ships with the plugin. `/tmb:agent-create` drafts each one per project from `templates/agents/template.md`, and the project-local file serves the consultant from then on.

The runtime registry of known agents is the `agents` table in the trajectory DB.

**Composition rule:** agent file = identity; `skills:` array = capabilities (additive); spawn prompt = task context (per call). A "more skilled swe" is `swe.md` plus added skills, not a different `swe.md`.

---

## Design philosophy

Three roles, split by what each can be trusted to do without marking its own homework, and by which one stays alive when something unexpected fires:

- **bro** — the persona on the main Claude thread. Holds the full picture (system design and alignment with the Human) and the widest permissions. Bro does everything except coding, is the only agent that talks to the Human, and owns every workflow state change.
- **swe** — codes. Coding splits out for three reasons:
  1. **Token-heavy** — doing it in bro would fill bro's strategic context with diff noise.
  2. **No self-homework** — the verification gate runs the spec's checks on swe's commit, and the review handoff refuses a commit without a passing recorded run. The agent that writes the code does not sign it off.
  3. **Subagents are fragile** — swe runs as a subagent with a narrow tool allowlist and a fresh context; a hook deny or MCP error can end its run. Critical state writes stay with bro, the most permissioned and most resilient layer.
- **code-reviewer** — an independent third party at the push gate. It has no Edit or Write tool. The only agent whose verdict the push gate accepts.

Each layer owns one level of quality and no layer repeats another's check: the Human intent, bro the environment, the spec and the architecture, swe functionality, code-reviewer the diff; see [Quality layers](FLOWS.md#quality-layers).

---

## bro

Source: the plugin's `CLAUDE.md` (there is no `agents/bro.md`; hooks deliver the persona).

- **Plans and routes.** Grounds each ask in the trajectory DB and the world model, proposes a branch, writes the task spec, and provisions the task together with its branch and worktree.
- **Gates tasks.** When swe returns, bro hands the commit to review and spawns code-reviewer. After a pass it judges only the architecture fit and the swe's extras, re-running no checks and re-reviewing no diff, then closes the task. A close writes the verification audit row and the status change in one transaction.
- **Gates pushes.** bro reads the verdict from its recorded row (never from reply text), integrates the base when it moved, pushes and opens the PR.
- **Never edits source.** Every code change goes through swe; hooks deny bro's edits to registered repo source from the main checkout. Unregistered sibling repos in a multi-repo workspace are outside that guard (see [`REPO_RESOLUTION.md`](./REPO_RESOLUTION.md)).
- **Talks to the Human.** Only bro asks the Human questions and reports to them.

---

## swe

Source: `agents/swe.md`.

- **Spawn contract.** bro spawns swe with a task id; a spawn gate refuses a spawn without a valid, provisioned task. swe arrives in the task's worktree and reads its brief first.
- **Works in the worktree only.** It edits, tests and commits on the task branch bro provisioned. It never creates branches or worktrees, never fetches, rebases or pushes, and never edits outside its worktree or the prompt surface unless the task allows it.
- **Closes atomically.** It commits with the spec's commit message and reports completion with a typed report: each success criterion with its evidence, every path edited outside the task's files with a reason, and the review findings it fixed. The verification gate runs the spec's checks before the completion is accepted.
- **Stops on a hook block.** A deny is a hard stop; swe reruns in the form the deny names, or closes failed and quotes the hook to bro.
- **Hands back.** When the work will not fit its turns, it commits and returns a checkpoint so the next run resumes.

Scope is recorded at the review handoff, with swe's reason for each extra, and judged at close: bro's close compares the task's own commits with its declared files, and either the extras are reverted through swe or bro accepts them with a recorded reason. code-reviewer reads that record instead of recomputing it.

---

## code-reviewer

Source: `agents/code-reviewer.md`.

- **Spawn contract.** bro spawns one reviewer per completed task, after its review handoff and before the close, with the task's anchors only; a preflight hook checks the anchors and the branch before the reviewer runs.
- **Reviews from the records.** It reads the task brief, the recorded verification run (each check's exit code, time and output tail) and the scope record, runs none of swe's checks again, and spends the review on its own probes of what the diff's dependents rely on.
- **Signs off.** It records a typed verdict with findings. The server derives the reviewer's identity itself and refuses a verdict that is not independent of the swe that wrote the commit. The push gate admits a push only when each pushed task commit has a passing verdict.
- **Never edits files** and never changes task status.

---

## Consultants

Drafted per project on demand via `/tmb:agent-create` from `templates/agents/template.md`; no named consultant templates ship.

- **Cannot write workflow state** — issues, tasks, status changes and verdicts are refused by the server.
- **Can write analyses** as discussion rows.
- **Advise, never decide.** bro spawns consultants for second opinions, reports their analysis to the Human, and **the Human decides**.

---

## How roles are enforced

Every trajectory-server tool declares which roles may call it, reading the role from the `agent` argument the caller passes. A PreToolUse hook compares that argument with the caller's real agent type (or `bro` for the main session) and denies a mismatch, so a subagent cannot act as bro and the main session cannot act as a subagent. The role-by-tool matrix is the `requireRoles` calls in `mcp/trajectory-server/src/tools/`; the per-agent tool allowlists are the `tools:` frontmatter in `agents/*.md`.
