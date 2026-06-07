# docs/

Developer documentation for the TMB plugin. Read these when you're contributing to the plugin itself.

**Not part of bro's runtime context.** Nothing in this tree is auto-loaded into a Claude Code session. Bro's runtime lives in `CLAUDE.md`, `agents/`, `skills/`, `hooks/`, the trajectory DB, and the kuzu world model.

If something in `docs/` turns out to be load-bearing for bro's behavior, inline it where bro actually reads it.

| File / folder | Purpose |
|---|---|
| `AGENTS.md` | Agent layer model + override rules |
| `reference/REFERENCE.md` | Where workflow state lives (DB, files, CC config) |
| `reference/BENCHMARK.md` | L0–L6 test pyramid + perf notes |
| `reference/MULTI_PLATFORM.md` | OS compatibility notes |
| `reference/UPGRADE.md` | Plugin version migration notes |
| `architecture/` | Design rationale (ERD, FILES, FLOWS, GIT, RESPONSIBILITIES, UI, WORLD_MODEL) |
| `prompt-engineering/` | DETERMINISM, ENFORCEMENT, PROMPT_ENGINEERING |
| `commands/` | Per-slash-command design docs |
| `contributing/` | Code-quality criteria + review findings catalogue |
