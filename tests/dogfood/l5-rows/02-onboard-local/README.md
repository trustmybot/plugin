# 02-onboard-local

**Scenario under test:** the user picks a *local* shape during onboarding (no remote, GitHub-flow branching, PR target = `main`). Per the partial-test pattern, the L5 unit can't drive the AUQ rounds — the fixture pre-seeds the post-AUQ state and the test confirms the seeded state matches doctrine.

**🟡 Partial-test:** the real onboarding ceremony renders 3+ AUQ rounds (branching model → remote shape → PR target). Headless test mode suppresses AUQ. The L5 verifies the fixture seeded the expected local-shape values; the L6 chain step uses the same seed to bridge from row 1's intent signal to row 4's first task.

## Pre-state

`onboarding-named` fixture, which seeds:
- `identity` row exists (onboarded marker)
- `plugin_config[branching_model]='"github-flow"'`
- `plugin_config[pr_target]='"main"'`
- `plugin_config[protected_branches]='["main"]'`
- `plugin_config[remotes]='[]'`
- `plugin_config[issue_sync]='off'`
- `audit(event_type='deep_scan_completed')` row exists (registry-cold gate cleared)

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro the project just got onboarded with local-shape defaults — confirm the active config so I know we're aligned.` |
| → | bro | reads state via MCP (likely `tmb_config-policy` or directly via `issue_state_get` / `plugin_config` reads); recaps branching model + pr_target + remotes; no DB writes |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `identity` row exists; `plugin_config.branching_model = "github-flow"`; `plugin_config.pr_target = "main"`; `plugin_config.remotes = "[]"`; `deep_scan_completed` audit exists |
| `outcome-coherence.json` | `identity`: `=1`; `tasks`: `=0`; `audit WHERE event_type='deep_scan_completed'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | none required (this row is a state-recap; the partial-test verification is the fixture seed) |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` (no code work, no SWE) |
| `cost-budget.json` | Soft 100K / 300s |

**Failure modes captured:** fixture drift — if `onboarding-named.sql` stops seeding `branching_model` or `pr_target`, the L5 catches it. Downstream rows depend on these values (row 7's push gate, row 12's resume).
