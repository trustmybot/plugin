# architecture-regen-direct (misc — edge case)

**Scenario under test:** the Human says "refresh the architecture docs". Bro must fire `architecture_regen(scope='full')` directly — no `tmb_planning`, no issue, no task, no SWE.

## What this captures

`CLAUDE.md` Routing table:

> | **Command — non-code** (refresh arch) | `architecture_regen(scope='full')` directly, or Bash if pre-authorized |

This routing rule is load-bearing — `architecture_regen` is a maintenance operation that operates on `docs/trustmybot/architecture/auto/`, NOT a feature. Routing it through `tmb_planning` would create a spurious issue and task, polluting the trajectory DB.

The bug class this catches: bro misrouting non-code asks through `tmb_planning` instead of recognizing the direct-tool affordance.

## Pre-state

`onboarding-named` fixture.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro refresh the architecture docs — pull in any recent code changes` |
| → | bro | calls `architecture_regen(agent='bro', scope='full')` directly; no issue/task created |
| 2 | user | `Looks good. Anything else?` |
| → | bro | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a `regen_state` row updated (or just any audit row tied to architecture_regen) — substantive check is in `tools-required.json` below |
| `outcome-coherence.json` | `tasks`: `=0`; `issues WHERE id != 999999`: `=0` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `architecture_regen` |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` (no SWE dispatch — this is a non-code op) |
| `cost-budget.json` | Soft 200K / 600s |
