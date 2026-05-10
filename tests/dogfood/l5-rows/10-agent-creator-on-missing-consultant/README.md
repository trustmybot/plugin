# 10-agent-creator-on-missing-consultant

**Scenario under test:** the Human asks for the cto's opinion. The cto agent is registered (as `scope='template'`) but its file isn't in `.claude/agents/` yet. Bro must invoke `tmb_agent-creator` to copy the template + re-register at `scope='project-local'` BEFORE spawning via `Agent`.

## What this captures

`skills/tmb_agent-creator/SKILL.md` Branch B (template-copy):

> 1. Read the template via Read.
> 2. Copy on approval (or unconditionally in headless). Write the template content unmodified.
> 3. Call `agent_register(name, kind='consultant', scope='project-local', file_path='.claude/agents/<name>.md', tmb_owner='bro')`. ... Then `audit_log(issue_id=<that_id>, event_type='tmb_agent_created', ...)`.

The bug class this catches: bro spawning `Agent(subagent='cto')` on a missing local file (which would silently fail or use a stale registry entry), instead of invoking the agent-creator's template-copy ceremony first.

## Pre-state

`onboarding-named` fixture. `.claude/agents/` contains only the always-installed `swe.md` and `pr-reviewer.md` — no `cto.md`. The DB registry has cto with `scope='template'` (per the schema seed).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro spawn the cto and have them weigh in on whether we should switch from a monolith to microservices` |
| → | bro | calls `agent_list`, sees cto is template-scope, invokes `tmb_agent-creator` (template-copy → file landed at `.claude/agents/cto.md` + `agent_register` → `audit_log`), then spawns cto via `Agent` |
| 2 | user | `Good. Move on.` |
| → | bro | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | an `audit` row with `event_type='tmb_agent_created'` exists. (Note: `agent_register` is `INSERT OR IGNORE` in the server, so the cto row's scope stays `template` — that's a known server-side gap, not a bro-behaviour gap. The audit row is the load-bearing signal that the agent-creator ceremony ran.) |
| `outcome-coherence.json` | `audit WHERE event_type = 'tmb_agent_created'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `agent_list`, `agent_register`, `Agent` |
| `tools-forbidden.json` | none — file_registry / discussion writes are fine for context |
| `cost-budget.json` | Soft 200K / 600s |
