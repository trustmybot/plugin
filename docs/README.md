# docs/

Developer documentation for the TMB plugin. Read these when you're contributing to the plugin itself.

**Not part of bro's runtime context.** Nothing in this tree is auto-loaded into a Claude Code session. Bro's runtime lives in `CLAUDE.md`, `agents/`, `skills/`, `hooks/`, and the trajectory DB.

If something in `docs/` turns out to be load-bearing for bro's behavior, inline it where bro actually reads it.

| File / folder | Purpose |
|---|---|
| `AGENTS.md` | Agent layer model + override rules |
| `REFERENCE.md` | Where workflow state lives (DB, files, CC config) |
| `BENCHMARK.md` | L0–L6 test pyramid + perf notes |
| `MULTI_PLATFORM.md` | OS compatibility notes |
| `UPGRADE.md` | Plugin version migration notes |
| `architecture/` | Design rationale (DETERMINISM, ENFORCEMENT, ERD, FILES, FLOWS, GIT, RESPONSIBILITIES, UI) |
| `commands/` | Per-slash-command design docs |
| `contributing/` | Code-quality criteria + review findings catalogue |
