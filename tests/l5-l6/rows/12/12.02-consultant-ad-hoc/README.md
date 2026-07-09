# 12.02-consultant-ad-hoc

**Flow under test**: `FLOWS.md §C — Consultant invocation`. Bro spawns a single project-local consultant for a second opinion. (Renamed from `C-consultant` per the single-tree canonical layout.)

**Pre-state** (`onboarding-named` + `setup-l5.sh`): identity set, `.claude/agents/architect.md` from `templates/agents/`.

**Trigger**: `@bro get the architect's read on whether SQLite WAL mode is sufficient for our concurrency model`

**Expected behavior**:
1. Bro globs `.claude/agents/`, finds `architect.md`
2. Spawns architect via `Agent`
3. Architect writes `discussion_append(kind='analysis')`
4. Bro relays the read to the Human

**L5 mode**: `setup-l5.sh` copies architect.md from plugin templates.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | ≥0 discussions with `kind='analysis'` (trajectory_required=Agent is the gate) |
| `tools-required.json` | `Agent`, `agent_list` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | 80K / 120s soft |