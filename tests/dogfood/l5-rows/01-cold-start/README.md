# 01-cold-start

**Scenario under test:** fresh CC session against an empty TMB DB. Human types `@bro hi`. Bro must auto-fire the onboard chain — call `onboard_state_get` (sees `first_run=true`), load `commands/onboard.md` body, and call `onboard_get_questions` to begin the AUQ rounds.

**🟡 Partial-test:** in test mode the AUQ-suppression prefix prevents AUQ rendering; this row asserts only the **initiation** signal (the two MCP calls bro must make BEFORE rendering AUQ). The post-AUQ state is seeded by row 2's fixture (`onboarding-named`) for downstream rows in the L6 chain.

## Pre-state

`empty` fixture (no `identity`, no `plugin_config` keys, no `deep_scan_completed` audit). Fresh `git init` repo with no commits.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro hi` |
| → | bro | `activation-routine.sh` injects `onboarded=no`. Bro auto-routes to `/onboard`: calls `onboard_state_get` → reads first_run=true → calls `onboard_get_questions` → would render AUQ rounds (suppressed in test mode). Test ends here. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | trivial pass — substantive check is in `tools-required.json`. No `identity` row is asserted (lands via row 2 fixture seed in L6). |
| `outcome-coherence.json` | `identity`: `=0` (still empty); `tasks`: `=0` (no code work this row) |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `onboard_state_get` AND `onboard_get_questions` (= "bro initiated the AUQ chain") |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` (no code work, no SWE) |
| `cost-budget.json` | Soft 150K / 600s |

**Failure modes captured:** bro stops at `onboard_state_get` without progressing to `onboard_get_questions` (forgets the chain); bro skips onboard entirely and dives into project work (skipping cold-start); bro creates issue/task without onboarding (caught by tools-forbidden).
