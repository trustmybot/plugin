# 06.01-swe-retry

**Source:** L5 `08-swe-retry` (renumbered per reconciliation table).

**Scenario:** Pre-seeded failed task + failure discussion. Bro should call `task_retry` composite (tmb_planning §Step 5 retry path), which emits `task_retry_attempted` audit event atomically.

**L5 mode:** `setup-l5.sh` seeds `onboarding-named` + injects failed task + concern discussion.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | ≥2 tasks; ≥2 discussions; `task_retry_attempted` audit event |
| `tools-required.json` | `task_retry` |
| `tools-forbidden.json` | `validation_record` |
| `cost-budget.json` | Soft 80K / 120s |
