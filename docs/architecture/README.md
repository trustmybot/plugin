# docs/architecture/

Design rationale for how the TMB plugin is built — the schema, the workflow gates, the role boundaries, and the substrates bro reasons from. Read these when you need the "why" behind a structure, not just the "what."

| File | Purpose |
|---|---|
| [`ERD.md`](./ERD.md) | Trajectory DB entity-relationship diagram — the SQLite schema, table groups, and where the DB lives on disk |
| [`FLOWS.md`](./FLOWS.md) | The Human → bro → SWE decision chain and the two gates (bro = task gate, pr-reviewer = push gate) |
| [`RESPONSIBILITIES.md`](./RESPONSIBILITIES.md) | The role × tool matrix — what each shipped agent is actually instructed to do, plus server-enforced boundaries |
| [`GIT.md`](./GIT.md) | Where each actor's git state lives across a task lifecycle; the local-is-canonical invariant |
| [`REPO_RESOLUTION.md`](./REPO_RESOLUTION.md) | Path-keyed repo resolution — how an operation's path identifies its repo via the `repos` table; registration-based guard scoping; per-repo `protected_branches` |
| [`HEADLESS_ENFORCEMENT.md`](./HEADLESS_ENFORCEMENT.md) | Why CC doesn't fire marketplace plugin hooks under `claude -p` — enforced headless bro requires a `--plugin-dir` sideload; marketplace-headless is explicitly unenforced; the L5/L6 caveat |
| [`WORLD_MODEL.md`](./WORLD_MODEL.md) | The kuzu world-model graph — bro's queryable project map, built by `scan_run` |
| [`TYPED_RAILS.md`](./TYPED_RAILS.md) | Promoting enforced fields (`files`, `verification`) from markdown to typed schema columns |
| [`CHEATCODES.md`](./CHEATCODES.md) | The discover → vet → install → hot-load pipeline for acquiring skills, MCP toolkits, and plugins on demand |
| [`UI.md`](./UI.md) | The interactive UI primitives Claude Code exposes and how bro renders them |
