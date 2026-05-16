# 06-push-gate

**Flow under test**: `FLOWS.md §6 — Push gate / PR review`. Bro runs `tmb_review §B` which spawns `pr-reviewer` subagent per unsigned task.

**Pre-state** (`onboarding-named` + custom seed): one task in `needs_validation` with a real commit on `feat/seed-todo`.

**Trigger**: `@bro the task on feat/seed-todo is signed off — review and push it`

**Expected behavior**:
1. Bro recognises push-gate ask
2. Loads `tmb_review §B`
3. Spawns `pr-reviewer` for task #1 via `Task`
4. pr-reviewer reads diff, issues `validation_record(verdict='pass'|'fail')`

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | `validation_attempts` has ≥1 row total and ≥1 row for task #1 |
| `tools-required.json` | `Task` + `validation_record` |
| `tools-forbidden.json` | `task_create_batch` |
| `cost-budget.json` | Soft 100K / 120s |
