# C-consultant

**Flow under test**: `FLOWS.md §C — Consultant invocation`. Bro spawns a single project-local consultant for a second opinion.

**Pre-state** (`onboarding-named` + custom seed): identity set, `.claude/agents/architect.md` from `templates/agents/`.

**Trigger**: `@bro get the architect's read on whether SQLite WAL mode is sufficient for our concurrency model`

**Expected behavior**:
1. Bro globs `.claude/agents/`, finds `architect.md`
2. Spawns architect via `Task`
3. Architect writes `discussion_append(kind='analysis')`
4. Bro relays the read to the Human

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | ≥1 `discussions` row with `kind='analysis'` |
| `tools-required.json` | `Task`, `discussion_append` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Soft 80K / 120s |
