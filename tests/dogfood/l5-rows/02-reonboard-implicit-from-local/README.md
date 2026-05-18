# 02-reonboard-implicit-from-local

**Scenario under test:** the project is onboarded with local-shape defaults (no remote). The user signals reonboard intent implicitly — "I want to push this project to a remote" — without naming a provider or running `/onboard`. Bro must recognize the reonboard signal, call `onboard_state_get` (check current state), and either auto-apply via `onboard_apply` or recommend `/onboard`. No code work may begin.

This is the **implicit** reonboard path. Compare step 03 (`03-reonboard-remote`) for the **explicit** `/onboard` ceremony path.

## Pre-state

`onboarding-named` fixture + `setup.sh` re-seeds plugin_config local-shape values:
- `identity` row exists
- `plugin_config[branching_model]='"github-flow"'`
- `plugin_config[pr_target]='"main"'`
- `plugin_config[protected_branches]='["main"]'`
- `plugin_config[remotes]='[]'`
- `plugin_config[issue_sync]='"off"'`
- `audit(event_type='deep_scan_completed')` row exists

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro I want to push this project to a remote.\n\nDon't ask questions.` |
| → | bro | calls `onboard_state_get`. Either path is acceptable: (a) auto-apply via `onboard_apply(shape='remote', …)` or (b) recommend `/onboard` in text and stop. No code work — no tasks, no issues, no SWE spawn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | identity row intact; `deep_scan_completed` audit intact |
| `outcome-coherence.json` | `identity`: `=1`; `tasks`: `=0`; `audit WHERE event_type='deep_scan_completed'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `onboard_state_get` |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` (no code work) |
| `cost-budget.json` | Soft 100K / 300s |

**Failure modes captured:** bro starts code work instead of reonboarding; bro doesn't recognize the reonboard intent at all; bro names a specific provider even though the user didn't.
