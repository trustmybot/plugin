# 15-agent-runs-recorded-on-swe-completion

**Scenario under test:** every SWE / pr-reviewer subagent run should land an `agent_runs` row at SubagentStop. Production showed `agent_runs` was **0** despite multiple sessions where bro should have dispatched SWE — meaning either the dispatch never happened OR the `swe-atomic-close.sh` SubagentStop hook silently failed.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* The empty `agent_runs` table is the canonical "subagent ran but the world didn't notice" production signature.

## Pre-state

`onboarding-named` (gate pre-cleared via fixture seed). Source pre-seeded.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro implement an add command for the TODO CLI in src/cli.py` |
| → | bro | full plan + spawn SWE; SWE runs in worktree, commits, calls `task_update_status(completed)`; SubagentStop hook fires `swe-atomic-close.sh` writing the `agent_runs` row |
| 2 | user | `Wrap it up.` |
| → | bro | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `agent_runs` row count ≥1 with non-null `task_id` |
| `outcome-coherence.json` | `agent_runs`: `>=1`; `agent_runs WHERE task_id IS NOT NULL`: `>=1` |
| `tools-required.json` | `task_create_batch`, `Agent` (SWE) |
| `cost-budget.json` | Soft 200K / 900s |

**Failure mode this captures:** SWE subagent runs but `agent_runs` stays empty. Either bro never dispatched (caught by tools-required) OR SubagentStop didn't fire / silently failed (caught by `agent_runs` count).
