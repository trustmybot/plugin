# 10-consultant

**Scenario under test:** Human asks an architecture-trade-off question about the todo CLI's storage choice. The `consultant-spawn-required.sh` UserPromptSubmit hook (which is the deterministic enforcement surface after #198 part 2 retired the CLAUDE.md routing row) detects the architecture-trade-off pattern and injects a hint telling bro to invoke `/tmb:agent-create <role> <one-line restatement>`. Bro follows the hint, the slash command resolves the creation mode with `agent_resolve`, writes the agent file, registers it via `agent_register` (the server auto-audits `tmb_agent_created`), and spawns cto via `Agent`.

The row deliberately uses a naturalistic prompt with no role name — bro must classify from context, the same way a real user phrases it. Naming `cto` in the prompt would short-circuit the hook + bro's classification and test the literal string match rather than the description-driven path.

## Pre-state

`onboarding-named` fixture + `src/cli.py` (TODO CLI with JSON storage — matches step 04/05 chain output) + an open issue ("Evaluate TODO CLI storage scale-out"). `.claude/agents/` contains only the always-installed `swe.md` and `pr-reviewer.md` — no `cto.md`. The DB registry has cto seeded as `scope='template'` (per the schema seed).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro should we keep src/cli.py's storage in JSON or move to SQLite as the CLI scales?\n\nDon't ask questions.` |
| → | bro | (consultant-spawn hook injects routing hint) → bro invokes `/tmb:agent-create cto` → command calls `agent_resolve` (server returns creation mode), writes the agent file, calls `agent_register(scope='project-local')` (server auto-audits `tmb_agent_created`), spawns cto via `Agent`. Single turn. |

## De-flake rationale

This row used to gate on a `tmb_agent_created` audit row — the load-bearing signal that bro *followed* the nudge and ran the agent-creator ceremony. That's **model behaviour**, not the enforcement mechanism: the consultant-spawn hint fires every run, but bro's compliance with the advisory nudge varies, so the gate flaked (local twin of GH #651/#865).

The gate now asserts the **deterministic** signal: the `consultant-spawn` class of `prompt-intent-hints.sh` writes a `consultant_spawn_nudged` audit row whenever it emits the domain-specialist nudge. That row is written by the UserPromptSubmit hook outside the LLM's control — it fires iff the enforcement mechanism fired, independent of whether bro then complied. `tmb_agent_created` stays in the picture only as an observational note (bro's compliance), never a pass criterion.

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | an `audit` row with `event_type='consultant_spawn_nudged'` exists (deterministic — the consultant-spawn enforcement nudge fired). |
| `outcome-coherence.json` | `audit WHERE event_type = 'consultant_spawn_nudged'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` (read-only consult — no commits) |
| `tools-required.json` | `agent_resolve`, `agent_register`, `Agent` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` (consultants don't drive workflow state) |
| `cost-budget.json` | Soft 200K / 600s |

**Failure modes captured:** (a) the consultant-spawn pattern in `prompt-intent-hints.sh` stops matching the architecture-trade-off prompt — caught by the `consultant_spawn_nudged` audit row missing; (b) bro answers directly from general knowledge or spawns a consultant without the ceremony — caught by `tools-required` (`agent_resolve` / `agent_register` / `Agent` missing). Bro's *compliance* with the nudge (`tmb_agent_created`) is observational, not a gate.
