# 04-first-task-hits-gate

**Scenario under test:** the user onboarded but `/scan` never ran (no `deep_scan_completed` audit row exists). User asks for a code change. Bro must run `/scan` (or `scan_run` directly) BEFORE `task_create_batch`. The registry-cold gate enforces this server-side; the test verifies bro responds to the gate correctly instead of waiving it silently.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* Bro skipping `/scan` is a P0 framework violation — the `file_registry` empty pattern from production traces directly to this.

## Pre-state

`onboarding-named` fixture, but `setup.sh` deletes the seeded `deep_scan_completed` audit row to simulate "user onboarded but never ran /scan".

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro make a todo CLI in Python.\n\nDon't ask questions.` |
| → | bro | tries `task_create_batch` → server returns `registry_cold_violation` → bro reads error → calls `scan_run` (auto-fire path per `commands/scan.md`) → re-tries `task_create_batch` and spawns SWE. Single turn — terminates when atomic-close lands. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a `deep_scan_completed` audit row exists; `tasks` row count ≥1 |
| `outcome-coherence.json` | `audit WHERE event_type='deep_scan_completed'`: `>=1`; `tasks`: `>=1`; `repos`: `>=1` (scan populated repos table) |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `scan_run`, `task_create_batch` |
| `tools-forbidden.json` | none — bro may legitimately retry |
| `cost-budget.json` | Soft 200K / 900s |

**Failure mode this captures:** bro waives the gate via `waive_registry_gate=true` instead of actually running `scan_run`. The audit row check fails → bug surfaced.
