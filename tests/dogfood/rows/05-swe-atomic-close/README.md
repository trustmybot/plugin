# 05-swe-atomic-close

**Scenario under test:** the canonical "did the work actually flow through SWE" row. User asks bro to add a feature on top of the existing TODO CLI. Bro plans + dispatches SWE via `Agent`; SWE runs in a worktree and at `SubagentStop` the `swe-atomic-close.sh` hook writes an `agent_runs` row tied to the task. Bro calls `bro_atomic_close` so the task flips out of `pending`.

The row asserts only the dispatch + atomic-close path. Whether bro additionally re-plans or re-scans is incidental — step 04 owns the gate-and-plan assertion; this row's mutually-exclusive scope is the SWE round-trip.

Two production bug classes captured:

1. **Tasks stuck at `pending`** — bro spawned SWE but never called `bro_atomic_close`.
2. **Empty `agent_runs`** — SWE ran but `agent_runs` stayed at 0 because dispatch never happened or `swe-atomic-close.sh` silently failed.

## Pre-state

`onboarding-named` fixture, plus `setup-l5.sh` simulates step 04's output: full TODO CLI committed at `src/cli.py` (add/list/done/remove on JSON storage at `~/.todo-cli/todos.json`), `repos` row, `deep_scan_completed` audit row.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro add a --priority flag to the todo CLI's add command so users can mark items high/medium/low. Store it in the JSON and surface it in list output.\n\nDon't ask questions.` |
| → | bro | scopes the feature → spawns SWE via `Agent` → SWE edits `src/cli.py`, commits → SubagentStop hook fires `swe-atomic-close.sh` → bro calls `bro_atomic_close`. Single turn — terminates when atomic-close lands. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `tasks` ≥1; **no** tasks at `pending`; `agent_runs` ≥1 with non-null `task_id` |
| `outcome-coherence.json` | `tasks`: `>=1`; `tasks WHERE status='pending'`: `=0`; `agent_runs`: `>=1`; `agent_runs WHERE task_id IS NOT NULL`: `>=1` |
| `tools-required.json` | `Agent`, `bro_atomic_close` |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** (a) bro stops without spawning SWE — caught by tools-required (`Agent` missing) AND coherence (`pending != 0`); (b) bro skips `bro_atomic_close` after SWE returns — caught by tools-required (`bro_atomic_close` missing) AND coherence (`pending != 0`); (c) SWE ran but `agent_runs` stayed empty — caught by `agent_runs >= 1`.
