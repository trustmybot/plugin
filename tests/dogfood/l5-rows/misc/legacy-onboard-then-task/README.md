# legacy-onboard-then-task (misc — pre-reframe)

**Scenario under test:** the bug Daisy hit on 2026-05 — bro answers a user's clarifying questions in chat, then silently creates a worktree from `main` without first making a feature branch, leaving the user's question + bro's answer absent from the `discussions` table.

## What this captures that L5 cannot

L5 is single-shot. The bug only surfaces across at least 2 turns:

1. User asks a code-change question (turn 1).
2. Bro responds with a clarifying question (in plain prose).
3. User answers (turn 2).
4. Bro takes action — must record the discussion AND make a feature branch, NOT commit to base.

L5 can't reproduce this because there's only one prompt. L6 with a queued user-reply chain reproduces it deterministically.

## Pre-state

`empty` fixture — schema only, no identity row, no tasks.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro hi, can you implement a hello-world function?` |
| → | bro | (auto-fires `/onboard` because identity is empty; runs the branched ceremony; **for L6 v1 the headless deny still fires** — bro takes the recovery default and proceeds) |
| → | bro | (after onboard, bro should triage as simple, plan the task, propose a branch_id) |
| 2 | user | `Yes, simplest possible — a function that prints "hello world".` |
| → | bro | (creates the branch, files an issue, writes the discussion, spawns SWE) |
| 3 | terminal | bro emits "task closed" or session hits max_turns |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `tasks` count >= 1; `tasks.branch_id != 'main'` |
| `outcome-coherence.json` | `issues >= 2` (system + the work issue); `tasks >= 1`; `discussions >= 2` (the user's question + bro's answer at minimum); `audit >= 2` (planning_complete + at least one bro decision event) |
| `outcome-git.json` | `base_branch_unchanged: true` (bro must NOT commit to main); the SWE worktree, if created, must be on `tasks.branch_id` (NOT detached, NOT on main) |
| `tools-required.json` | `onboard_state_get`, `issue_create`, `discussion_append`, `task_create_batch` |
| `tools-forbidden.json` | `validation_record` (push gate is a separate flow) |
| `cost-budget.json` | Soft 200K tokens / 600s — multi-turn is more expensive than single-shot |

## Why this scenario

Three bugs Daisy filed map to this single scenario:

1. **Empty `discussions`** — bro answered her question, never wrote it. Coherence assertion catches.
2. **Worktree from `main`** — git assertion catches.
3. **First-contact didn't fire `/onboard`** — `onboard_state_get` in `tools-required` catches.

If L6 catches all three on a single scenario run, we have evidence that the multi-turn integration model works for the failure class Daisy keeps hitting in real sessions.
