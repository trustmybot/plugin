# 14-swe-spawn-required-after-task-create

**Scenario under test:** after `task_create_batch`, bro must immediately spawn SWE via `Agent`. Production showed 2 tasks **stuck at `pending`** — bro called `task_create_batch` and then stopped without dispatching SWE.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* Tasks-without-SWE-spawn is a real production bug; the gate is closed at the planning level but bro can still drop the dispatch.

## Pre-state

`onboarding-named` (gate pre-cleared via fixture seed). Source pre-seeded so bro has something for SWE to edit.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro implement an add command for the TODO CLI in src/cli.py` |
| → | bro | full plan + `task_create_batch` + spawn SWE via `Agent` |
| 2 | user | `Wrap it up.` |
| → | bro | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | tasks count ≥1 AND tasks not all stuck at `pending` (some advanced to `running` / `completed` / `needs_validation` / `closed`) |
| `outcome-coherence.json` | `tasks`: `>=1`; `tasks WHERE status='pending'`: `=0` |
| `tools-required.json` | `task_create_batch`, `Agent` (the SWE spawn) |
| `cost-budget.json` | Soft 200K / 900s |

**Failure mode this captures:** bro creates tasks then stops (no `Agent` call). The tools-required check fails on `Agent` AND the coherence check fails because tasks are stuck at `pending`.
