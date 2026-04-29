# 09-roundtable

**Flow under test**: `FLOWS.md §9 — Roundtable`. Bro convenes 2-4 consultants for multi-perspective deliberation via `tmb_roundtable`.

**Pre-state** (`onboarding-named` + custom seed): identity set, plus `.claude/agents/architect.md` and `.claude/agents/pm.md` from `templates/agents/`.

**Trigger**: `@bro convene a roundtable with architect and pm on whether to migrate to event-sourced storage`

**Expected behavior**:
1. Bro recognises roundtable trigger
2. Loads `tmb_roundtable`
3. Skill globs `.claude/agents/`, finds architect + pm
4. Spawns each via `Task` in parallel
5. Each consultant writes `discussion_append(kind='analysis')`
6. Skill records `ledger_log(event_type='roundtable_summary')`

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Ledger has `roundtable_summary`; ≥2 `analysis` discussion rows |
| `tools-required.json` | `Task`, `discussion_append`, `ledger_log` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Soft 120K / 180s |
