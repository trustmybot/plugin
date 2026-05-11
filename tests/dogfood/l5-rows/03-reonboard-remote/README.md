# 03-reonboard-remote

**Scenario under test:** the user types `/onboard` on an already-onboarded project to switch from local (GitHub-flow, no remote) to remote (gitflow, GitLab). Bro must call `onboard_state_get` (sees `first_run=false`), call `onboard_get_questions(shape='remote')`, and would render AUQ rounds for the new branching model + remote provider.

**🟡 Partial-test:** AUQ rendering is suppressed in test mode. The L5 unit asserts the **re-initiation** signal (the two MCP calls). The post-AUQ state — flipping `branching_model` to `'gitflow'`, `pr_target` to `'dev'`, and adding a GitLab remote entry — is seeded by `setup.sh` so downstream rows see the new config.

## Pre-state

`onboarding-named` fixture (local-shape state, identity row exists). `setup.sh` does NOT pre-apply the remote-shape values — that happens after the AUQ-intent signal so the test can observe `onboard_state_get` returning `first_run=false`.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/onboard\n\nDon't ask questions.` |
| → | bro | `roundtable-slash-detect.sh` doesn't match. The onboard slash command handler routes to bro. Bro calls `onboard_state_get` → reads `first_run=false` → calls `onboard_get_questions(shape='remote' or default)` → would render AUQ. Test ends here. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | trivial pass — substantive check is in `tools-required.json`. Identity row remains intact (no row resets). |
| `outcome-coherence.json` | `identity`: `=1` (unchanged); `tasks`: `=0` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `onboard_state_get` (bro re-initiated the onboard chain) |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` |
| `cost-budget.json` | Soft 150K / 600s |

**Failure modes captured:** bro skips `onboard_state_get` and re-runs onboarding from scratch (would create a duplicate identity row); bro auto-applies remote-shape values without asking (would skip `onboard_get_questions`).
