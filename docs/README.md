# docs/

Developer documentation for the TMB plugin. Read these when you're contributing to the plugin itself.

**Not part of bro's runtime context.** Nothing in this tree is auto-loaded into a Claude Code session. Bro's runtime lives in `CLAUDE.md`, `agents/`, `skills/`, `hooks/`, and the trajectory DB (workflow audit plus the world model).

If something in `docs/` turns out to be load-bearing for bro's behavior, inline it where bro actually reads it.

Each folder's `README.md` lists the files it holds.

| Folder | Purpose |
|---|---|
| [`reference/`](./reference/) | Operational lookups: where state lives, config keys, install, upgrade, platforms |
| [`architecture/`](./architecture/) | Design rationale: the schema, the workflow gates, the role boundaries, the world model |
| [`prompt-engineering/`](./prompt-engineering/) | How TMB writes and enforces the prompts that drive its agents |
| [`contributing/`](./contributing/) | Naming, enum, label and changelog rules for contributors |
| [`adapters/`](./adapters/) | The platform-adapter development standard |
| `assets/` | Images the READMEs embed |
