# 03-consultant-architect-read

**Scenario under test:** Human asks "what does the architect think about X?". Bro should consult the agent registry (`agent_list`), load `tmb_agent-creator` if needed, spawn the architect via `Agent`, get its analysis (recorded as `discussions(kind='analysis')`), and surface back to the Human.

## What this captures

The bug class found on 2026-05: bro spawned a named consultant directly via `Agent` without first calling `agent_list` — bypassing the registry-as-source-of-truth doctrine introduced in #184. The fix made the `consultant-spawn-required.sh` hook data-driven (loads names from the agents registry SQLite table), but the *positive test* that bro actually consults the registry was an L5 flow that didn't exercise multi-turn.

L6 catches it deterministically: across two turns (user asks → bro responds with the analysis), `agent_list` must appear in the trajectory + a discussion of `kind='analysis'` must land.

## Pre-state

`onboarding-named` fixture. The architect template is pre-seeded by schema (in the `agents` registry table at `kind='consultant', scope='template'`); `setup.sh` copies the architect template file into `.claude/agents/architect.md` so `Agent` can spawn it locally.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro what's the architect's read on whether SQLite WAL mode is sufficient for our concurrency model?` |
| → | bro | calls `agent_list` to discover the architect; spawns it via `Agent` |
| → | architect | reads context, returns its analysis as `discussions(kind='analysis')` |
| → | bro | summarizes the architect's read back to the Human |
| 2 | user | `Thanks, that's clear.` |
| → | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | At least one `discussions` row with `kind='analysis'` for the active issue |
| `outcome-coherence.json` | `discussions WHERE kind='analysis' >= 1`; `audit >= 1` (consultant_spawned event or similar) |
| `outcome-git.json` | `base_branch_unchanged: true` (no commits — this is read-only consult) |
| `tools-required.json` | `agent_list` (registry consult) + `Agent` (spawn) |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` (consultants don't drive workflow state) |
| `cost-budget.json` | Soft 150K / 300s |
