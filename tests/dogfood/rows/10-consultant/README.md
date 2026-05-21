# 10-consultant

**Scenario under test:** Human asks a tech-strategy question that falls naturally into CTO territory. Bro must:

1. Call `agent_list` first (registry is source of truth — not bro's mental model).
2. Classify the ask as `cto` via description match (the prompt does not name a consultant role explicitly).
3. If the consultant's file is missing under `.claude/agents/`, invoke `tmb_agent-creator` to copy the template + re-register at `scope='project-local'` + write a `tmb_agent_created` audit row.
4. Spawn the consultant via `Agent`.

This row folds two production bug classes into one:

- **#03 (architect ask):** bro spawned a named consultant via `Agent` without first calling `agent_list`, bypassing the registry-as-source-of-truth doctrine introduced in #184.
- **#10 (template-copy ceremony):** bro called `Agent(subagent='cto')` on a missing local file, which would silently fail or use a stale registry entry, instead of running the agent-creator template-copy ceremony first.

The unified row exercises the "template-copy required" path because it's a strict superset — `agent_list` is the prerequisite for either branch, and the template-copy ceremony adds the audit-row signal that's hard to fake.

## Realistic-prompt design

The prompt is a genuine user ask — a scaling/architecture question that belongs to CTO scope — with no explicit role name. Bro must infer the right consultant from context, the same way a real user would phrase it. Naming `cto` in the prompt would short-circuit bro's classification logic and test the literal string match rather than the description-match path; that's an unrealistic shortcut and was the original defect.

## Pre-state

`onboarding-named` fixture. `.claude/agents/` contains only the always-installed `swe.md` and `pr-reviewer.md` — no `cto.md`. The DB registry has cto seeded as `scope='template'` (per the schema seed).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro the todo CLI is starting to be used as a team-shared tool — should we move the JSON-file storage to SQLite (or even a small server) before the multi-user load gets uglier, or stick with the current shape?\n\nDon't ask questions.` |
| → | bro | reads the prompt as a tech-strategy/architecture ask; classifies as `cto` via description match; calls `agent_list`, sees cto is template-scope, invokes `tmb_agent-creator` (template-copy → file landed at `.claude/agents/cto.md` + `agent_register` + `audit_log` with `event_type='tmb_agent_created'`), then spawns cto via `Agent`. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | an `audit` row with `event_type='tmb_agent_created'` exists (load-bearing signal that the agent-creator ceremony ran). Note: `agent_register` is `INSERT OR IGNORE` in the server, so the cto registry row's scope stays `template` — a known server-side gap, not a bro-behaviour gap. |
| `outcome-coherence.json` | `audit WHERE event_type = 'tmb_agent_created'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` (read-only consult — no commits) |
| `tools-required.json` | `agent_list`, `agent_register`, `Agent` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` (consultants don't drive workflow state) |
| `cost-budget.json` | Soft 200K / 600s |

**Failure modes captured:** (a) bro skips `agent_list` and spawns from memory — caught by tools-required (`agent_list` missing); (b) bro calls `Agent(subagent='cto')` on missing file — caught by tools-required (`agent_register` missing) AND outcome.sql (no `tmb_agent_created` audit row); (c) bro asks for clarification instead of classifying from context — caught by tools-required (`agent_list` missing from a zero-tool clarification turn).
