# Architecture

TMB's design of record: how the plugin is shaped and why. Read it to understand a part of TMB before you change it, or to check that a change still fits the design.

## Three layers of knowledge

TMB's own repo keeps each fact in exactly one of three layers, at the level of detail that layer holds best:

- **High-level design: these docs.** Components, boundaries, flows, invariants and the reasons behind them. They name no functions, files, tables or tool parameters, so a refactor does not make them stale.
- **Mid-level relationships: the world model.** What lives where and what depends on what, derived from the code so it cannot drift from it. [WORLD_MODEL.md](WORLD_MODEL.md) covers it.
- **Low-level logic: the code.** How a step is done, in self-explaining names and tests.

A fact belongs in the lowest layer that can hold it. A rule a check can enforce goes in code; a relationship the world model can derive goes there; only the design and its reasons stay here. When a page here starts naming symbols, the detail has drifted into the wrong layer: move it down, don't copy it. The one exception is a generated page guarded by a freshness test, such as [ERD.md](ERD.md).

This rule is how TMB develops itself. It comes from our experience of design and code drifting apart, not from research evidence that it prevents that drift, and users cannot opt in to it yet. In a user's project, TMB provides the bottom two layers: the world model and the code.

## Reading guide

New to TMB? Read in this order:

1. [PHILOSOPHY.md](PHILOSOPHY.md) — why TMB is built the way it is.
2. [FLOWS.md](FLOWS.md) — what happens, one ideal-case chart per flow, and which design wins when a prompt and a hook disagree.
3. [RESPONSIBILITIES.md](RESPONSIBILITIES.md) — who does each step.
4. [TASKS.md](TASKS.md) — every case of a task, from ask to merge, and why one gets stuck.
5. [MEMORY.md](MEMORY.md) and [WORLD_MODEL.md](WORLD_MODEL.md) — what agents remember and how they find their way around a project.
6. [GIT.md](GIT.md) — where the work sits at every stage of a task.
7. [CONTAINMENT.md](CONTAINMENT.md), [CHEATCODES.md](CHEATCODES.md) and [EXTENDING.md](EXTENDING.md) — the safety boundary, and how TMB extends itself inside it.

Each flow in FLOWS.md links to its detail page, which charts every case, failures included, and how to debug them.

Looking for one answer instead?

| Question | Read |
|---|---|
| Why does TMB do X at all? | [PHILOSOPHY.md](PHILOSOPHY.md) |
| What happens when the Human asks for Y? | [FLOWS.md](FLOWS.md) |
| Why won't the plugin start, or why is it degraded? | [INSTALL.md](INSTALL.md) |
| What does first contact ask, and what does it record? | [ONBOARD.md](ONBOARD.md) |
| How does bro learn a repo's test and lint commands? | [ENVIRONMENT.md](ENVIRONMENT.md) |
| Why is my task stuck? | [TASKS.md](TASKS.md) |
| How does a project gain an agent, a skill or a second opinion? | [EXTENDING.md](EXTENDING.md) |
| Which agent may do Z? | [RESPONSIBILITIES.md](RESPONSIBILITIES.md) |
| What does an agent see at the start of a turn? | [MEMORY.md](MEMORY.md) |
| How does bro know where code lives? | [WORLD_MODEL.md](WORLD_MODEL.md) |
| Which branch is the work on, and which repo? | [GIT.md](GIT.md) |
| May TMB write to this path? | [CONTAINMENT.md](CONTAINMENT.md) |
| How does bro add a published skill or MCP server? | [CHEATCODES.md](CHEATCODES.md) |
| What does the trajectory DB store? | [ERD.md](ERD.md) |
| Where does function X live? | Not here: ask the world model |

## Index

- [PHILOSOPHY.md](PHILOSOPHY.md) — The principles behind the design: how an idea becomes tasks, the dev-vs-user-runtime boundary, one owner per quality check, code over prompts for enforcement, clean removal, and hot and cold memory.
- [FLOWS.md](FLOWS.md) — One ideal-case chart per flow, from install to bug reports, plus the quality layers every flow is built on.
- [INSTALL.md](INSTALL.md) — Install and session start in every case, and what to check when the plugin is missing or degraded.
- [ONBOARD.md](ONBOARD.md) — First contact: its rounds, what each records, and how a re-run keeps what still stands.
- [ENVIRONMENT.md](ENVIRONMENT.md) — How bro learns and caches a repo's install, test and lint commands, with the repo as the source of truth.
- [TASKS.md](TASKS.md) — Every case of a task from ask to merge: the push gate, retry and escalation, PR comment triage, and debugging a stuck task.
- [EXTENDING.md](EXTENDING.md) — How a project gains agents, skills, consultants and roundtables, and what each path refuses.
- [RESPONSIBILITIES.md](RESPONSIBILITIES.md) — What each shipped agent is for, what it may and may not do, and why the roles are split this way.
- [MEMORY.md](MEMORY.md) — The memory model every agent follows: cold storage in the trajectory DB, hot session context, and pinned prompts, with the cost of each tier.
- [WORLD_MODEL.md](WORLD_MODEL.md) — The world model bro reasons from: its purpose, its boundaries, and why it is a derived cache rebuilt by scanning.
- [GIT.md](GIT.md) — Where each actor's git state lives at every stage of a task, with local branches as the source of truth, and how a multi-repo workspace resolves each operation to its repo.
- [CONTAINMENT.md](CONTAINMENT.md) — TMB's promise to write nothing outside the project it runs in, the layers that keep it, and the few declared exceptions.
- [CHEATCODES.md](CHEATCODES.md) — How bro adds published skills, MCP toolkits and plugins on demand, and the trust and approval gates on the way.
- [ERD.md](ERD.md) — The trajectory DB schema as an entity relationship diagram, grouped into workflow, registry, world-model and search tables. Generated from the schema.
