# 14-skill-invocation-recorded

**Scenario under test:** when bro invokes a Skill via the Skill tool, the `skill-invocation-record.sh` PostToolUse hook (#2886) writes a row to `skill_invocations` attributing it to bro's open agent_run. Closes the "did the agent use the skill it should have" detection loop end-to-end.

## Pre-state

`onboarding-named` fixture. `setup.sh` pre-seeds an open bro agent_run row (mimicking the state mid-task), so the hook has something to FK to.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro add a hello-world function to src/main.py that prints "hello, world".` |
| → | bro | reads the prompt as a real code-touching ask; `tmb_planning` auto-loads via description match ("Bro's full code-touching flow"); bro invokes the Skill tool, the PostToolUse hook fires and writes the junction row. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | ≥1 row in `skill_invocations` referencing a tmb_* skill — proves the hook wrote the junction row. The pre-seeded bro agent_run row's id appears as the `agent_run_id` FK. |
| `outcome-coherence.json` | `skill_invocations` count `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` (this is read-only) |
| `tools-required.json` | `Skill` — bro must invoke the Skill tool at least once for the hook to fire |
| `tools-forbidden.json` | none |
| `cost-budget.json` | Soft 60K / 120s |

**Failure modes captured:** the Skill PostToolUse hook isn't registered in hooks.json; the hook fires but can't find the DB; the skills catalog is empty so the hook silently skips the write; bro answers conversationally without invoking the Skill tool at all.
