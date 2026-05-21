# 04-first-task-hits-gate

**Scenario under test:** the user onboarded but `/scan` never ran (no `deep_scan_completed` audit row). User asks to *scope* a TODO CLI project. Bro must run `/scan` (or `scan_run` directly) BEFORE `task_create_batch` — the registry-cold gate enforces this server-side, and the test verifies bro responds correctly instead of waiving silently.

**Scope of this row:** the gate response + planning only. SWE dispatch + atomic-close are step 05's job. The prompt explicitly tells bro to NOT dispatch this turn so steps 04 and 05 stay mutually exclusive in chain context.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* Bro skipping `/scan` is a P0 framework violation — the `file_registry` empty pattern from production traces directly to this.

## Pre-state

`onboarding-named` fixture, but `setup.sh` deletes the seeded `deep_scan_completed` audit row to simulate "user onboarded but never ran /scan".

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro start scoping the todo CLI project — create the issue + initial task spec so SWE can pick it up next turn. Don't dispatch SWE this turn.\n\nDon't ask questions.` |
| → | bro | tries `task_create_batch` → server returns `registry_cold_violation` → bro reads error → calls `scan_run` → re-tries `task_create_batch` and STOPS (no `Agent` spawn this turn). |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `deep_scan_completed` audit row; `tasks` ≥1; `repos` ≥1 |
| `outcome-coherence.json` | `audit WHERE event_type='deep_scan_completed'`: `>=1`; `tasks`: `>=1`; `repos`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `scan_run`, `task_create_batch` |
| `tools-forbidden.json` | `Agent` — dispatch is step 05's job |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** (a) bro waives the gate via `waive_registry_gate=true` instead of running `scan_run` → the audit row check fails; (b) bro spawns SWE this turn → `Agent` in forbidden list catches it (this would also pull in step 05's purpose, breaking mutual exclusivity).
