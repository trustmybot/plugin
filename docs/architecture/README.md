# Architecture

TMB's design of record: how the plugin is shaped and why. These pages describe architecture only; the world model answers what calls or reads what, and the code holds the logic.

## Index

- [PHILOSOPHY.md](PHILOSOPHY.md) — The principles behind the design: the two review gates, the dev-vs-user-runtime boundary, hot and cold memory, and clean removal of replaced designs.
- [FLOWS.md](FLOWS.md) — The ground truth for every workflow, from install and cold start to task handling and bug reports. Its Quality layers section sets the two axes every flow is built on.
- [RESPONSIBILITIES.md](RESPONSIBILITIES.md) — What each shipped agent is for, what it may and may not do, and why the roles are split this way.
- [MEMORY.md](MEMORY.md) — The memory model every agent follows: cold storage in the trajectory DB, hot session context, and pinned prompts, with the cost of each tier.
- [WORLD_MODEL.md](WORLD_MODEL.md) — The world model bro reasons from: its purpose, its boundaries, and why it is a derived cache rebuilt by scanning.
- [ERD.md](ERD.md) — The trajectory DB schema as an entity relationship diagram, grouped into workflow, registry, world-model and search tables. Generated from the schema.
- [GIT.md](GIT.md) — Where each actor's git state lives at every stage of a task, built on local branches as the source of truth and origin as downstream.
- [REPO_RESOLUTION.md](REPO_RESOLUTION.md) — How TMB decides which repo an operation belongs to in a multi-repo workspace, by matching paths against registered repos.
- [CONTAINMENT.md](CONTAINMENT.md) — TMB's promise to write nothing outside the project it runs in, the invariants that keep it, and the few declared exceptions.
- [CHEATCODES.md](CHEATCODES.md) — The search, vet, install and activate pipeline that lets bro add published skills, MCP toolkits and plugins on demand.
