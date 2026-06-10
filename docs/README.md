# docs/

Developer documentation for the TMB plugin. Read these when you're contributing to the plugin itself.

**Not part of bro's runtime context.** Nothing in this tree is auto-loaded into a Claude Code session. Bro's runtime lives in `CLAUDE.md`, `agents/`, `skills/`, `hooks/`, the trajectory DB, and the kuzu world model.

If something in `docs/` turns out to be load-bearing for bro's behavior, inline it where bro actually reads it.

| File / folder | Purpose |
|---|---|
| `reference/REFERENCE.md` | Where workflow state lives (trajectory DB, kuzu world model, CC config) |
| `reference/MULTI_PLATFORM.md` | OS compatibility notes |
| `reference/UPGRADE.md` | Plugin version migration notes |
| `architecture/` | Design rationale (ERD, FLOWS, GIT, RESPONSIBILITIES, UI, WORLD_MODEL) |
| `prompt-engineering/` | DETERMINISM, ENFORCEMENT, PROMPT_ENGINEERING |
| `contributing/` | Benchmark methodology (BENCHMARK) + enum/label registries (ENUMS, LABELS) |
