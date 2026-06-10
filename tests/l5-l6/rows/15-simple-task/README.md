# 15-simple-task

**Source:** L5 `02-simple-task` (renumbered per reconciliation table).

**Scenario:** Onboarded project with named identity. User asks bro to write a Python CLI todo app — a simple, non-architectural code-touching ask. Bro should triage as simple, create issue + task, spawn SWE.

**L5 mode:** `setup-l5.sh` seeds `onboarding-named` fixture state.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | Issue with todo/cli objective exists; task created; planning chain ran |
| `tools-required.json` | `branch_id_propose` called |
| `tools-forbidden.json` | `validation_record` NOT called |
| `cost-budget.json` | Soft 50K tokens / 60s |
