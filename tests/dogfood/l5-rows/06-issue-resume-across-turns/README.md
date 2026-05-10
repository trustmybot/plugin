# 06-issue-resume-across-turns

**Scenario under test:** there's an in-progress issue with a pending task already planned (`planning_complete` audit row exists, task in `pending` state). The Human says "let's keep going on issue 1" — bro must pick up the existing planning state and proceed to SWE dispatch, NOT re-run `tmb_planning` from the top and create a duplicate issue / duplicate tasks.

## What this captures

The L6 model (cumulative DB across turns) makes resume-from-state a first-class scenario. L5 can't catch this because every L5 flow starts with a clean DB.

The bug class this catches: bro overplanning — re-creating an issue / re-running task_create_batch when the existing planning state is already complete. That's a real session-history bug ("bro re-asked questions when the issue was already planned").

## Pre-state

`onboarding-named` fixture + a pre-seeded issue and task on `feat/seed-cli`:
- `issues(id=1, status='open', objective='Add a CLI entry point')`
- `tasks(id=1, issue_id=1, branch_id='feat/seed-cli', status='pending')`
- `audit(issue_id=1, event_type='planning_complete')`

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro let's keep going on issue 1 — the CLI entry point. Pick it up and dispatch SWE.` |
| → | bro | reads existing state via `issue_state_get(issue_id=1)`, dispatches SWE for task 1 — does NOT call `issue_create` or `task_create_batch` |
| 2 | user | `Looks good. Wrap it up.` |
| → | bro | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | exactly 1 issue (id=1) — bro did NOT create a duplicate; tasks count is exactly 1 (no duplicate planning) |
| `outcome-coherence.json` | `issues WHERE id != 999999`: `=1`; `tasks`: `=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `Agent` (SWE dispatch). The "must read existing state" half is asserted by `outcome.sql` + `outcome-coherence.json` — if bro replanned, those would show 2/2. |
| `tools-forbidden.json` | `issue_create`, `task_create_batch` — bro must NOT replan |
| `cost-budget.json` | Soft 200K / 600s |
