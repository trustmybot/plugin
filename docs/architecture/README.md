# Architecture

TMB's design of record: how the plugin is shaped and why. Read it to understand a part of TMB before you change it, or to check that a change still fits the design.

## Three layers of knowledge

TMB keeps each fact in exactly one of three layers, at the level of detail that layer holds best:

- **High-level design: these docs.** Components, boundaries, flows, invariants and the reasons behind them. They name no functions, files, tables or tool parameters, so a refactor does not make them stale.
- **Mid-level relationships: the world model.** What lives where, what calls, imports or reads what, and the concepts that tie code to design. Ask it with `world_model_search`, `world_model_get` and `world_model_symbol`; `/scan` rebuilds it from the code, so it never drifts.
- **Low-level logic: the code.** How a step is done, in self-explaining names and tests. Read the code when the world model has pointed you to it.

A fact belongs in the lowest layer that can hold it. A rule a check can enforce goes in code; a relationship the scan can derive goes in the world model; only the design and its reasons stay here. When a page here starts naming symbols, the detail has drifted into the wrong layer: move it down, don't copy it. The one exception is a generated page guarded by a freshness test, such as [ERD.md](ERD.md).

## Reading guide

New to TMB? Read in this order:

1. [PHILOSOPHY.md](PHILOSOPHY.md) — why TMB is built the way it is.
2. [FLOWS.md](FLOWS.md) — what happens, flow by flow. Its Quality layers section is the design every other page builds on, and it wins any conflict with a prompt or a hook.
3. [RESPONSIBILITIES.md](RESPONSIBILITIES.md) — who does each step.
4. [MEMORY.md](MEMORY.md) and [WORLD_MODEL.md](WORLD_MODEL.md) — what agents remember and how they find their way around a project.
5. [GIT.md](GIT.md) — where the work sits at every stage of a task.
6. [CONTAINMENT.md](CONTAINMENT.md) and [CHEATCODES.md](CHEATCODES.md) — the safety boundary, and how TMB extends itself inside it.

Looking for one answer instead?

| Question | Read |
|---|---|
| Why does TMB do X at all? | [PHILOSOPHY.md](PHILOSOPHY.md) |
| What happens when the Human asks for Y? | [FLOWS.md](FLOWS.md) |
| Which agent may do Z? | [RESPONSIBILITIES.md](RESPONSIBILITIES.md) |
| What does an agent see at the start of a turn? | [MEMORY.md](MEMORY.md) |
| How does bro know where code lives? | [WORLD_MODEL.md](WORLD_MODEL.md) |
| Which branch is the work on, and which repo? | [GIT.md](GIT.md) |
| May TMB write to this path? | [CONTAINMENT.md](CONTAINMENT.md) |
| How does bro add a published skill or MCP server? | [CHEATCODES.md](CHEATCODES.md) |
| What does the trajectory DB store? | [ERD.md](ERD.md) |
| Where does function X live? | Not here: ask the world model |

## Index

- [PHILOSOPHY.md](PHILOSOPHY.md) — The principles behind the design: the two review gates, the dev-vs-user-runtime boundary, hot and cold memory, and clean removal of replaced designs.
- [FLOWS.md](FLOWS.md) — The ground truth for every workflow, from install and cold start to task handling and bug reports. Its Quality layers section sets the two axes every flow is built on.
- [RESPONSIBILITIES.md](RESPONSIBILITIES.md) — What each shipped agent is for, what it may and may not do, and why the roles are split this way.
- [MEMORY.md](MEMORY.md) — The memory model every agent follows: cold storage in the trajectory DB, hot session context, and pinned prompts, with the cost of each tier.
- [WORLD_MODEL.md](WORLD_MODEL.md) — The world model bro reasons from: its purpose, its boundaries, and why it is a derived cache rebuilt by scanning.
- [GIT.md](GIT.md) — Where each actor's git state lives at every stage of a task, with local branches as the source of truth, and how a multi-repo workspace resolves each operation to its repo.
- [CONTAINMENT.md](CONTAINMENT.md) — TMB's promise to write nothing outside the project it runs in, the layers that keep it, and the few declared exceptions.
- [CHEATCODES.md](CHEATCODES.md) — How bro adds published skills, MCP toolkits and plugins on demand, and the trust and approval gates on the way.
- [ERD.md](ERD.md) — The trajectory DB schema as an entity relationship diagram, grouped into workflow, registry, world-model and search tables. Generated from the schema.
