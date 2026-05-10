# 02-onboard-local

**Scenario under test:** the project is already onboarded with local-shape defaults (no remote, GitHub-flow, target=main). The user signals they want to *change that* — go remote, host on GitHub. Bro must recognize the reonboard intent, check current state, and **ask** whether to fire `/onboard` again. Bro must NOT auto-apply config changes.

**🟡 Partial-test:** bro stops at the question; the actual reonboard ceremony is handled in row 3 (where the user types `/onboard` explicitly). This row tests bro's ability to read the user's vague intent ("make this available on GitHub") as a reonboard cue without short-circuiting to silent config rewrites.

## Pre-state

`onboarding-named` fixture + `setup.sh` re-seeds plugin_config local-shape values:
- `identity` row exists (onboarded marker)
- `plugin_config[branching_model]='"github-flow"'`
- `plugin_config[pr_target]='"main"'`
- `plugin_config[protected_branches]='["main"]'`
- `plugin_config[remotes]='[]'`
- `plugin_config[issue_sync]='"off"'`
- `audit(event_type='deep_scan_completed')` row exists

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro I want to make this project available on GitHub.` |
| → | bro | calls `onboard_state_get`, sees current state is local; responds with a question like "want me to run `/onboard` again to switch to a remote shape?" — does NOT call `onboard_apply` or modify config |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | identity row intact; local-shape plugin_config values still present (bro didn't auto-rewrite) |
| `outcome-coherence.json` | `identity`: `=1`; `tasks`: `=0`; `audit WHERE event_type='deep_scan_completed'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `onboard_state_get` (bro checks current state) |
| `tools-forbidden.json` | `onboard_apply` (must NOT auto-apply), `task_create_batch`, `issue_create`, `Agent` |
| `script.json` terminal_pattern | bro mentions `/onboard` / `reonboard` / "run it again" — the question signal |
| `cost-budget.json` | Soft 100K / 300s |

**Failure modes captured:** bro silently auto-rewrites plugin_config to remote-shape values; bro starts code work without asking; bro doesn't engage with the intent at all.
