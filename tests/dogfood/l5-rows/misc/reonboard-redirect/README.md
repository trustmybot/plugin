# reonboard-redirect (misc — edge case)

**Scenario under test:** the Human asks for a re-onboarding-style change ("switch to gitflow", "change my issue tracker"). Bro must redirect to `/onboard`, NOT auto-fire onboarding tools or guess at the new config.

## What this captures

The CLAUDE.md `Routing` table has a row for "Reonboard-style ask" → "Tell the Human to type `/onboard`". The interactive ceremony lives in the slash command, not in any auto-firable phrase trigger. If a regression weakens that routing rule, bro starts mutating onboarding state on its own — which is exactly what `/onboard` exists to prevent.

The bug class this catches: bro calling `onboard_apply` (or `onboard_get_questions`) in response to a phrase trigger, instead of redirecting the Human to type `/onboard`.

## Pre-state

`onboarding-named` fixture (already onboarded — `branching_model='github-flow'`, `pr_target='main'`, `issue_sync='off'`).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro let's switch to gitflow with develop as the default branch from now on` |
| → | bro | redirects: "type `/onboard` to change branching model" — does NOT call `onboard_apply` |
| 2 | user | `Got it, anything else I should know?` |
| → | bro | brief acknowledgment, ends |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `plugin_config.value` for `branching_model` is still `github-flow` (no mutation happened); `identity` row count is still 1 |
| `outcome-coherence.json` | `issues WHERE id != -1`: `=0`; `tasks`: `=0` (bro didn't open work for this) |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | empty — bro shouldn't write anything substantive |
| `tools-forbidden.json` | `onboard_apply`, `onboard_get_questions` (the mutation tools); `task_create_batch` (no work to plan); `issue_create` |
| `cost-budget.json` | Soft 200K / 600s |
