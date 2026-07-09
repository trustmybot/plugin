# 05-first-task-hits-gate

**Scenario under test:** the user onboarded but `/scan` never ran (no `deep_scan_completed` audit row). User asks for a code change ("make a todo CLI"). Bro must run `/scan` (or `scan_run` directly) BEFORE it provisions any task — the world-model-cold gate enforces this server-side, and the test verifies bro responds correctly instead of waiving silently. Both task-creation paths are registry-gated: `task_create_batch` and the `task_provision` composite (bro's doctrine path). The gate fires whichever path bro reaches for.

The row also asserts **bro's skill usage** (bro invoked `tmb_planning` this turn + at least one `agent_runs` row for `agent_type='bro'`) — folded in from the (now-retired) step 14 since these signals naturally land on any chain step that invokes tmb skills, and step 04 is the first such step. Skill usage is read from the stream-json run log via the `usage` scorer (`outcome-usage.json`), not the retiring `skill_invocations` table (#118/#119).

The prompt is a natural full-feature ask, so bro typically also dispatches SWE + atomic-closes in the same turn — that's not exclusive with step 05 (which adds a feature on top); step 05's assertion just measures its own dispatch + close round trip.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* Bro skipping `/scan` is a P0 framework violation — the empty-world-model pattern from production traces directly to this.

## Pre-state

`onboarding-named` fixture, but `setup-l5.sh` deletes the seeded `deep_scan_completed` audit row to simulate "user onboarded but never ran /scan". Scaffolds `src/__init__.py` + `tests/__init__.py` so `/scan` discovers source structure.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro make a todo CLI by Python in src/cli.py with tests in tests/test_cli.py.\n\nDon't ask questions.` |
| → | bro | tries to provision a task (`task_provision`, its doctrine path — or `task_create_batch`) → server returns `registry_cold_violation` → bro reads error → calls `scan_run` → re-tries the provision. May continue to dispatch SWE + atomic-close in the same turn (allowed; step 05 owns its own assertion). |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `deep_scan_completed` audit row (proxy for kuzu graph warm); `tasks` ≥1; `repos` ≥1; `agent_runs` (`agent_type='bro'`) ≥1 |
| `outcome-coherence.json` | matching row counts |
| `outcome-usage.json` | bro invoked `tmb_planning` (from the stream-json run log) |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `scan_run`, `task_create_batch` |
| `tools-forbidden.json` | (none) |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** (a) bro waives the gate via `waive_registry_gate=true` instead of running `scan_run` → the `deep_scan_completed` audit check fails; (b) bro skips the planning chain and never loads `tmb_planning` → the `usage` scorer fails on the run log; (c) bro reaches for `task_provision` expecting it to bypass the gate — it no longer does, so the same `registry_cold_violation` fires and bro must still run `scan_run` first.
