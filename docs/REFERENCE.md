# Reference pointers

Lookups bro hits occasionally — keep here so they don't bloat CLAUDE.md.

## Where state lives

- **Trajectory DB** — SQLite at `<project>/.claude/<plugin-name>/trajectory.db`. The `<plugin-name>` segment matches `plugin.json.name`, so the stable channel writes to `.claude/tmb/` and the RC channel writes to `.claude/tmb-rc/` — full filesystem isolation when both are installed (#87). Project-local, gitignored, per-developer.
- **Task specs** — `tasks.spec_body` column, fetched via `task_get(task_id)`. NOT on disk.
- **ADRs** — `docs/trustmybot/architecture/manual/decisions/N-*.md`, hand-curated.
- **Auto-regenerated architecture docs** — `docs/trustmybot/architecture/auto/`, refreshed via `architecture_regen`.
- **Snapshots** — `docs/trustmybot/snapshots/<issue_id>.md`, generated via `issue_snapshot_md`.

## Other docs

- **Agent layer model + override rules** — [`AGENTS.md`](AGENTS.md)
- **Performance budgets** — `CONTRIBUTING.md` → Performance section
- **plugin_config keys** — `mcp/trajectory-server/docs/CONFIG_KEYS.md`
- **Full architecture** — `docs/architecture/FLOWS.md`
