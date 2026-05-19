# 92-base-branch

**Flow under test**: `plugin_config.pr_target` honored by `tmb_planning §Step 2`. Issue #101 allows base allowlist {dev, main, master}; this row regresses on default-fallback.

**Pre-state** (`onboarding-named` + `setup-l5.sh`): `pr_target='dev'`. Real `dev` branch exists in git.

**Trigger**: `@bro write a python cli todo`

**Expected behavior**:
1. Bro triages as simple
2. `tmb_planning §Step 2` reads `pr_target` from config
3. `task_create_batch` is called with `parent_branch_id='dev'`
4. No task falls back to 'main'

**L5 mode**: `setup-l5.sh` sets `pr_target='dev'` and creates the dev branch.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | ≥1 task; ≥1 task with `parent_branch_id='dev'`; 0 tasks with `parent_branch_id='main'` |
| `tools-required.json` | `task_create_batch`, `issue_create` |
| `tools-forbidden.json` | `validation_record` |
| `cost-budget.json` | 60K / 90s |