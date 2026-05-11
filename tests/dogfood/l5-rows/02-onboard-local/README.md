# 02-onboard-local

**Scenario under test:** the project is onboarded with local-shape defaults (no remote, GitHub-flow, target=main). The user signals reonboard intent — "make this available on GitLab" — combined with the standard "Don't ask questions." suffix. Bro must call `onboard_state_get` (check current state) then `onboard_apply` with `shape='remote'` and a GitLab remote.

The combination "don't ask questions" + "make available on GitLab" resolves to *auto-apply with conservative defaults*: bro adds the GitLab remote without changing other settings unnecessarily. He doesn't need to drive an interactive `/onboard` ceremony — the user gave clear intent + waived clarifying questions.

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
| 1 | user | `@bro I want to make this project available on GitLab.\n\nDon't ask questions.` |
| → | bro | calls `onboard_state_get`, then `onboard_apply(shape='remote', remote=['gitlab'], …)` to add the GitLab remote. No code work — no tasks, no issues, no SWE spawn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | identity row intact; `plugin_config.remotes` is non-empty (bro added a remote); `deep_scan_completed` audit intact |
| `outcome-coherence.json` | `identity`: `=1`; `tasks`: `=0`; `plugin_config WHERE key='remotes' AND value_json != '[]'`: `=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `onboard_state_get`, `onboard_apply` |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` (no code work) |
| `cost-budget.json` | Soft 100K / 300s |

**Failure modes captured:** bro starts code work instead of reonboarding; bro chases `gh repo create` / `glab repo create` external commands and never updates plugin_config; bro doesn't recognize the reonboard intent at all.
