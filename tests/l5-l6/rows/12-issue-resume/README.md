# 12-issue-resume

**Scenario under test:** there's an in-progress issue with a pending task already planned (`planning_complete` audit row exists, task in `pending` state). The Human says "let's keep going on issue 1" — bro must pick up the existing planning state and proceed to SWE dispatch, NOT re-run `tmb_planning` from the top and create a duplicate issue / duplicate tasks.

## What this captures

The L6 model (cumulative DB across turns) makes resume-from-state a first-class scenario. L5 can't catch this because every L5 flow starts with a clean DB.

The bug class this catches: bro overplanning — re-creating an issue / re-running task_create_batch when the existing planning state is already complete. That's a real session-history bug ("bro re-asked questions when the issue was already planned").

## Pre-state

`onboarding-named` fixture + a pre-seeded resume issue and task on `feat/add-count-subcommand` (id auto-increment for L6-chain compatibility):
- `issues(objective='Add count subcommand to todo CLI', status='open')`
- `tasks(branch_id='feat/add-count-subcommand', status='pending')`
- `audit(event_type='planning_complete')` linked to the resume issue

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro let's keep going on the CLI entry-point work.\n\nDon't ask questions.` |
| → | bro | the `resume-intent-hint.sh` hook detects "keep going" and injects context with the specific `task_id` / `branch_id` to resume; bro calls `task_get` + spawns SWE for the existing task. Does NOT call `issue_create` or `task_create_batch`. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | resume issue exists exactly once (`objective='Add count subcommand to todo CLI'`); task on `feat/add-count-subcommand` exists exactly once — bro did NOT replan |
| `outcome-coherence.json` | resume issue count `=1`; task on `feat/add-count-subcommand` count `=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `Agent` (SWE dispatch). The "must read existing state" half is asserted by `outcome.sql` + `outcome-coherence.json` — if bro replanned, those would show 2/2. |
| `tools-forbidden.json` | `issue_create`, `task_create_batch` — bro must NOT replan |
| `cost-budget.json` | Soft 200K / 600s |
