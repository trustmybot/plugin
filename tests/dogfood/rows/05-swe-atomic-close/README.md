# 05-swe-atomic-close

**Scenario under test:** after `task_create_batch`, bro must spawn SWE via `Agent`; SWE runs in a worktree and at `SubagentStop` the `swe-atomic-close.sh` hook writes an `agent_runs` row tied to the task. Two production bug classes folded into one row:

1. **Tasks stuck at `pending`** — bro called `task_create_batch` and stopped without dispatching SWE.
2. **Empty `agent_runs`** — SWE ran but `agent_runs` stayed at 0 because either dispatch never happened or `swe-atomic-close.sh` silently failed.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* This is the canonical "did the work actually flow through SWE" row of the journey.

## Pre-state

`onboarding-named` (gate pre-cleared via fixture seed). Source pre-seeded so SWE has something to edit.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro make a todo CLI in Python.\n\nDon't ask questions.` |
| → | bro | full plan + `task_create_batch` + spawn SWE via `Agent`; SWE commits, calls `task_update_status(completed)`; `SubagentStop` fires `swe-atomic-close.sh` writing the `agent_runs` row. Single turn — terminates when atomic-close lands. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `tasks` ≥1; **no** tasks at `pending`; `agent_runs` ≥1 with non-null `task_id` |
| `outcome-coherence.json` | `tasks`: `>=1`; `tasks WHERE status='pending'`: `=0`; `agent_runs`: `>=1`; `agent_runs WHERE task_id IS NOT NULL`: `>=1` |
| `tools-required.json` | `task_create_batch`, `Agent` (SWE spawn) |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** (a) bro stops after `task_create_batch` — caught by tools-required (`Agent` missing) AND coherence (`pending != 0`); (b) SWE ran but `agent_runs` stayed empty — caught by `agent_runs >= 1` assertion (dispatch silently dropped or SubagentStop hook broken).
