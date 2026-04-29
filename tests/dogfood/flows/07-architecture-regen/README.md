# 07-architecture-regen

**Flow under test**: `FLOWS.md §7 — Architecture regen`. Human phrase trigger invokes `tmb_refresh-architecture`.

**Pre-state** (`onboarding-named`): identity set, no prior arch docs.

**Trigger**: `@bro refresh the architecture docs`

**Expected behavior**:
1. Bro recognises the phrase trigger
2. Loads `tmb_refresh-architecture` with `scope='full'`
3. Skill calls `architecture_regen` MCP tool
4. MCP tool writes `regen_state` row + `file_registry` rows for arch paths

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | `regen_state` has ≥1 row; `file_registry` has ≥1 row at `docs/%architecture%` |
| `tools-required.json` | `architecture_regen` |
| `tools-forbidden.json` | No `task_create_batch` / `issue_create` / `validation_record` |
| `cost-budget.json` | Soft 80K / 120s |
