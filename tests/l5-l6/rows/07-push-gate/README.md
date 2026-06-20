# 07-push-gate

**Scenario under test:** the full push-gate flow — bro completes a task, user attempts `git push`, push-guard blocks unsigned commits, bro spawns pr-reviewer, pr-reviewer signs off, push proceeds.

## What this captures

L5 flow `06-push-gate` already exercises this single-shot. L6 adds a multi-turn validation layer:

1. The push-guard hook fires inside bro's session (not just on a synthetic test).
2. Bro receives the deny signal and routes to pr-reviewer correctly across turns.
3. The typed `mcp_available` column on `validation_record` carries the MCP-availability signal (1 = MCP up, 0 = honor-system fallback).
4. After signoff, bro can re-attempt the push and succeed.

The bug class this catches: a regression that drops the MCP-availability signal. The `validation_record` precondition requires the typed `mcp_available` boolean when `agent='pr-reviewer'` — if the agent template stops passing it, the row write fails the precondition and the push-gate flow would deadlock.

## Pre-state

`onboarding-named` fixture + a pre-seeded `needs_validation` task on `feat/seed-todo` with a real commit (set up by `setup-l5.sh`).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro git push\n\nDon't ask questions.` |
| → | bro | the `push-intent-hint.sh` hook injects context listing pending validation tasks on the current branch; bro spawns pr-reviewer (no worktree) for the seeded task |
| → | pr-reviewer | reads task spec + commit, writes `validation_record(verdict='pass', mcp_available=true, feedback='...')` |
| → | bro | re-attempts `git push`; push-guard now allows. Single turn, terminates when validation lands. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `validation_attempts` has at least 1 row for task_id=1 with `verdict='pass'` |
| `outcome-coherence.json` | `validation_attempts >= 1`; `audit` events for spawn + signoff |
| `outcome-git.json` | `{}` (empty — bro may FF-merge to main when no remote is configured; that's expected under `@bro git push`) |
| `tools-required.json` | `Agent` (pr-reviewer spawn). `validation_record` is NOT in this list because it's called by the pr-reviewer subagent — bro's trajectory.jsonl doesn't capture subagent tool calls. The DB-level `outcome.sql` + `outcome-coherence.json` assert the row landed instead. |
| `tools-forbidden.json` | none — push gate naturally calls a wide tool surface |
| `cost-budget.json` | Soft 200K / 600s |
