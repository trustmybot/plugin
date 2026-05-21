# 04-first-task-hits-gate

**Scenario under test:** the user onboarded but `/scan` never ran (no `deep_scan_completed` audit row). User asks for a code change. Bro must run `/scan` (or `scan_run` directly) BEFORE `task_create_batch` — the registry-cold gate enforces this server-side, and the test verifies bro responds correctly instead of waiving silently.

The row asserts only the gate response (scan ran + at least one task created + repo registered). Whether bro then continues to dispatch SWE and atomic-close in the same turn is incidental — those behaviors are step 05's purpose; this row's mutually-exclusive scope is the gate.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* Bro skipping `/scan` is a P0 framework violation — the `file_registry` empty pattern from production traces directly to this.

## Pre-state

`onboarding-named` fixture, but `setup.sh` deletes the seeded `deep_scan_completed` audit row to simulate "user onboarded but never ran /scan".

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro make a todo CLI in Python.\n\nDon't ask questions.` |
| → | bro | tries `task_create_batch` → server returns `registry_cold_violation` → bro reads error → calls `scan_run` → re-tries `task_create_batch`. May continue to dispatch SWE + atomic-close in the same turn (allowed; the row's assertions stop at the gate). |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `deep_scan_completed` audit row; `tasks` ≥1; `repos` ≥1 |
| `outcome-coherence.json` | `audit WHERE event_type='deep_scan_completed'`: `>=1`; `tasks`: `>=1`; `repos`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `scan_run`, `task_create_batch` |
| `tools-forbidden.json` | (none — bro is free to dispatch in the same turn; step 05 owns the dispatch-and-close assertion) |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** bro waives the gate via `waive_registry_gate=true` instead of running `scan_run` → the `deep_scan_completed` audit row check fails.
