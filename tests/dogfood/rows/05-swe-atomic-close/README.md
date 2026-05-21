# 05-swe-atomic-close

**Scenario under test:** the canonical "did the work actually flow through SWE" row. After a task is pre-planned (by step 04 in chain, or by `setup-l5.sh` in L5), bro spawns SWE via `Agent`; SWE runs in a worktree and at `SubagentStop` the `swe-atomic-close.sh` hook writes an `agent_runs` row tied to the task. Bro then calls `bro_atomic_close` so the task flips out of `pending`.

**Scope of this row:** dispatch + atomic-close only. Planning (issue + task_create_batch + scan) is step 04's job. The prompt explicitly tells bro the task is already planned and just needs dispatching, so steps 04 and 05 stay mutually exclusive in chain context.

Two production bug classes this row catches:

1. **Tasks stuck at `pending`** — bro spawned SWE but never called `bro_atomic_close`.
2. **Empty `agent_runs`** — SWE ran but `agent_runs` stayed at 0 because dispatch never happened or `swe-atomic-close.sh` silently failed.

## Pre-state

`onboarding-named` fixture, plus `setup-l5.sh` simulates step 04's output: scan ran (`deep_scan_completed` audit row), `repos` row exists, one open issue + one task in `pending` state with a complete `spec_body`. `src/__init__.py` scaffolded so SWE has a directory to land `src/cli.py` in.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro the todo CLI task is already planned (issue + task_create_batch ran in the prior turn — task is in `pending`). Dispatch SWE now to implement it and atomic-close when done.\n\nDon't ask questions.` |
| → | bro | picks up the existing pending task (NO `issue_create`, NO `task_create_batch`); spawns SWE via `Agent`; SWE commits `src/cli.py`; `SubagentStop` fires `swe-atomic-close.sh`; bro calls `bro_atomic_close`. Single turn — terminates when atomic-close lands. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `tasks` ≥1; **no** tasks at `pending`; `agent_runs` ≥1 with non-null `task_id` |
| `outcome-coherence.json` | `tasks`: `>=1`; `tasks WHERE status='pending'`: `=0`; `agent_runs`: `>=1`; `agent_runs WHERE task_id IS NOT NULL`: `>=1` |
| `tools-required.json` | `Agent` (the dispatch) |
| `tools-forbidden.json` | `issue_create`, `task_create_batch` — planning is step 04's job |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** (a) bro stops without spawning SWE — caught by tools-required (`Agent` missing) AND coherence (`pending != 0`); (b) bro re-plans (calls `issue_create` or `task_create_batch`) — caught by tools-forbidden, breaks mutual exclusivity with step 04; (c) SWE ran but `agent_runs` stayed empty — caught by `agent_runs >= 1`.
