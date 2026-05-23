# 04-first-task-hits-gate

**Scenario under test:** the user onboarded but `/scan` never ran (no `deep_scan_completed` audit row). User asks for a code change ("make a todo CLI"). Bro must run `/scan` (or `scan_run` directly) BEFORE `task_create_batch` — the world-model-cold gate enforces this server-side, and the test verifies bro responds correctly instead of waiving silently.

The row also asserts the **skill-invocation hook attribution** (`skill_invocations` rows for `tmb_*` skills + at least one `agent_runs` row for `agent_type='bro'`) — folded in from the (now-retired) step 14 since these signals naturally land on any chain step that invokes tmb skills, and step 04 is the first such step.

The prompt is a natural full-feature ask, so bro typically also dispatches SWE + atomic-closes in the same turn — that's not exclusive with step 05 (which adds a feature on top); step 05's assertion just measures its own dispatch + close round trip.

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* Bro skipping `/scan` is a P0 framework violation — the empty-world-model pattern from production traces directly to this.

## Pre-state

`onboarding-named` fixture, but `setup.sh` deletes the seeded `deep_scan_completed` audit row to simulate "user onboarded but never ran /scan". Scaffolds `src/__init__.py` + `tests/__init__.py` so `/scan` discovers source structure.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro make a todo CLI by Python in src/cli.py with tests in tests/test_cli.py.\n\nDon't ask questions.` |
| → | bro | tries `task_create_batch` → server returns `registry_cold_violation` → bro reads error → calls `scan_run` → re-tries `task_create_batch`. May continue to dispatch SWE + atomic-close in the same turn (allowed; step 05 owns its own assertion). |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `deep_scan_completed` audit row; `tasks` ≥1; `repos` ≥1; `directories` ≥1 (world model warm); `skill_invocations` (`tmb_*`) ≥1; `agent_runs` (`agent_type='bro'`) ≥1 |
| `outcome-coherence.json` | matching row counts |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `scan_run`, `task_create_batch` |
| `tools-forbidden.json` | (none) |
| `cost-budget.json` | Soft 200K / 900s |

**Failure modes captured:** (a) bro waives the gate via `waive_registry_gate=true` instead of running `scan_run` → the `deep_scan_completed` audit check fails; (b) the `skill-invocation-record.sh` PostToolUse hook (#2886) regressed and stops attributing tmb skill invocations → `skill_invocations` assertion fails.
