# 08-swe-retry

**Flow under test**: `FLOWS.md §8 — SWE retry / escalation`.

**Pre-state** (`onboarding-named` + custom seed): one task in `failed` with a `concern` discussion describing the failure.

**Trigger**: `@bro that task on feat/seed-todo failed verification — review the feedback and retry with a corrected approach`

**Expected behavior**:
1. Bro reads the failed task + discussion via MCP
2. Loads `task_retry_batch composite + tmb_planning §Step 5 retry`
3. Appends a retry analysis
4. Calls `task_create_batch` with the corrected spec

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | `tasks` count ≥ 2; `discussions` count ≥ 2 |
| `tools-required.json` | `discussion_append`, `task_create_batch` |
| `tools-forbidden.json` | `validation_record` |
| `cost-budget.json` | Soft 80K / 120s |
