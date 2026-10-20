# 16-concurrent-tasks

**Scenario under test:** the Human asks for two independent changes in one message — a `count` subcommand and a `--json` flag on `list`. Bro must plan them as two tasks on distinct branches and dispatch both swes in the same turn (GH 1261 concurrent dispatch), not serialize them or fold them into one task.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` commits `src/cli.py` (a todo CLI with `add` and `list`, JSON store at `todos.json`) on `main` and inserts the `repos` row for the project (`INSERT OR IGNORE`, target `main`, `github-flow`) so `task_provision` resolves the repo and creates each task's worktree.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro add a "count" subcommand and, separately, a "--json" output flag to the list command. They're independent.\n\nDon't ask questions.` |
| → | bro | two `task_provision` calls (one per change, distinct branches), then two swe `Agent` spawns. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a count task and a `--json` task exist on distinct branches; `planning_complete` audit rows on ≥2 distinct branches; swe `agent_runs` rows on ≥2 distinct tasks |
| `outcome-coherence.json` | `tasks >= 2`; `planning_complete >= 2`; swe `agent_runs >= 2` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `task_provision`, `Agent` |
| `tools-forbidden.json` | `AskUserQuestion` |
| `cost-budget.json` | Soft 400K / 1200s (two swes) |

## Gaps (proxies)

- **Two calls, not one.** `tools-required.json` proves `task_provision` and `Agent` were called at least once; the scorers do not count tool calls. The counts come from the DB: `task_provision` writes one `planning_complete` row per task, and `record-swe-spawn.sh` writes one swe `agent_runs` row per spawn that passed every gate.
- **One bro turn.** The row runs one turn (`max_turns: 1`), so both spawns landing in the run stands in for "same turn". Whether the two spawns went out in parallel (one assistant message) or back to back is not scored.
