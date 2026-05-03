# 03-difficult-task

**Flow under test**: `FLOWS.md §3 — Difficult Task` (architecture-touching code change).

**Pre-state** (`onboarding-named`): identity set to `Test User`, schema-seeded config. Narratively chained from 02 — the python todo CLI is the implied existing code, but no DB state from 02 carries over (each flow runs in its own scratch project).

**Trigger**: `@bro add a sync API to that python todo CLI — design the storage architecture first since it touches multiple modules and changes the public surface`

**Expected behavior**:
1. Bro detects code-touching ask
2. Triages as `difficult` (architecture-impacting: storage layer + public API surface)
3. Loads `tmb_planning-difficult` skill — runs Q+A captured as discussion rows
4. Creates issue + task
5. Logs `planning_complete` event

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Issue + task created; ≥1 discussion row (difficult-path differentiator); audit has `planning_complete` event (kind='event') |
| `tools-required.json` | `issue_create`, `task_create_batch`, `discussion_append`, `audit_log` |
| `tools-forbidden.json` | `validation_record` (pr-reviewer scope, not bro at planning time) |
| `cost-budget.json` | Soft 80K / 90s |
