# 05.06-base-branch

**Flow under test**: `repos.target_branch` honored server-side by `task_provision`, which defaults `parent_branch_id` from it (bro passes no `base`). Issue #101 allows base allowlist {dev, main, master}; this row regresses on default-fallback.

**Pre-state** (`onboarding-named` + `setup-l5.sh`): `repos.target_branch='dev'`. Real `dev` branch exists in git.

**Trigger**: `@bro write a python cli todo`

**Expected behavior**:
1. Bro triages as simple
2. `task_provision` defaults `parent_branch_id` from `repos.target_branch`
3. `task_create_batch` is called with `parent_branch_id='dev'`
4. No task falls back to 'main'

**L5 mode**: `setup-l5.sh` seeds `repos.target_branch='dev'` and creates the dev branch.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | ≥1 task; ≥1 task with `parent_branch_id='dev'`; 0 tasks with `parent_branch_id='main'` |
| `tools-required.json` | `task_create_batch`, `any_of` (`issue_create`, `intent_start`) |
| `tools-forbidden.json` | `validation_record` |
| `cost-budget.json` | 60K / 90s |