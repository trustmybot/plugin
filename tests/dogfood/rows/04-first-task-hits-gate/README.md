# 04-first-task-hits-gate

**Scenario under test:** the user onboarded but `/scan` never ran (no `deep_scan_completed` audit row exists). User asks for a code change. Bro must run `/scan` (or `scan_run` directly) BEFORE `task_create_batch`. The registry-cold gate enforces this server-side; the test verifies bro responds to the gate correctly instead of waiving it silently. **Also covers the SWE atomic-close path** — since row 5 was retired from the L6 chain, row 4 now asserts the full happy path through to `bro_atomic_close` (task flipped from pending, `agent_runs` row landed). This catches the bug class where bro spawns SWE, SWE commits, but the task stays at `pending` because `bro_atomic_close` was never called or failed silently.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* Bro skipping `/scan` is a P0 framework violation — the `file_registry` empty pattern from production traces directly to this. Bro forgetting to atomic-close after SWE returns is the symmetric P0 (live repro 2026-05-11).

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
| `outcome.sql` | a `deep_scan_completed` audit row exists; `tasks` row count ≥1; no tasks stuck at `pending`; `agent_runs` row with non-null `task_id` |
| `outcome-coherence.json` | `audit WHERE event_type='deep_scan_completed'`: `>=1`; `tasks`: `>=1`; `tasks WHERE status='pending'`: `=0`; `repos`: `>=1`; `agent_runs`: `>=1`; `agent_runs WHERE task_id IS NOT NULL`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `scan_run`, `task_create_batch`, `Agent` (SWE spawn) |
| `tools-forbidden.json` | none — bro may legitimately retry |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes this captures:**
1. Bro waives the gate via `waive_registry_gate=true` instead of actually running `scan_run` → the audit row check fails.
2. Bro stops after `task_create_batch` without dispatching SWE → `Agent` missing in tool trajectory + `tasks WHERE status='pending'` > 0.
3. SWE ran but the SubagentStop hook didn't land an `agent_runs` row → `agent_runs >= 1` fails.
4. Bro spawned SWE, SWE committed, but `bro_atomic_close` was never called (or failed silently) → `tasks WHERE status='pending'` > 0 with `agent_runs >= 1` (the exact 2026-05-11 production repro).
