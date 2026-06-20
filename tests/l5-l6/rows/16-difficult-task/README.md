# 16-difficult-task

**Source:** L5 `03-difficult-task` (renumbered per reconciliation table).

**Scenario:** Onboarded project with a pre-seeded `todo.py`. User asks for a sync API — an architecture-touching change that triggers the difficult-path Q+A flow in `tmb_planning`. Bro must write `kind='decision'` discussions before creating a task.

**L5 mode:** `setup-l5.sh` seeds `onboarding-named` state + commits `todo.py` as prior work.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | Issue + task created; ≥1 discussion row (difficult-path differentiator); planning_complete audit |
| `tools-required.json` | `issue_create`, `task_create_batch`, `discussion_append`, `audit_append` |
| `tools-forbidden.json` | `validation_record` NOT called |
| `cost-budget.json` | Soft 80K / 90s |
