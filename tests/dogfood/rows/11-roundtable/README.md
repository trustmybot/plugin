# 11-roundtable

**Scenario under test:** two-phase test combining `/tmb:agent-create` Branch C (from-scratch agent via base `templates/agents/template.md`) with `/roundtable`. The roundtable mixes one **templated** consultant (`cto`, pre-seeded so we don't re-test Branch B here) and one **from-scratch** consultant (`data-engineer`, created in this row's Phase 1). Closes pending #51 / #221.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` pre-seeds:

- `templates/agents/cto.md` copied into `.claude/agents/cto.md` AND `cto` INSERTed into the `agents` table at `scope='project-local'` (so this row doesn't re-test Branch B — that's row 10's job)
- An open issue + a SQLite-decision discussion (`kind='decision'`) — context the roundtable cites
- No `.claude/agents/data-engineer.md`, no `data-engineer` row in `agents` — Phase 1 must create both via Branch C
- No `architect` / `pm` pre-seed (this row deliberately uses a **2-participant** roundtable to keep the mixed-template-vs-scratch signal clean)

## Phase 1 — from-scratch agent creation

Turn 1 prompt is `/tmb:agent-create data-engineer`. `data-engineer` is NOT in `templates/agents/` so Branch C fires. In `claude -p` (headless via slash command), bro auto-proceeds per SKILL.md §"Headless mode" Branch C: scaffolds from base `templates/agents/template.md` with default body, runs `prompt-author-lint.sh`, writes `.claude/agents/data-engineer.md`, calls `agent_register(scope='project-local')`, writes `audit_log(event_type='tmb_agent_created', content_json={mode:'from-scratch'})`.

## Phase 2 — mixed-participant roundtable

Turn 2 prompt is `/roundtable Should we use ClickHouse or PostgreSQL for our analytics warehouse? data-engineer + cto.\n\nDon't ask questions.`. Bro calls `roundtable_create(participants=['cto','data-engineer'], topic=...)`, spawns both via `Agent`, each writes `discussion_append(kind='analysis')` + a `roundtable_vote`.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/tmb:agent-create data-engineer` |
| → | bro | invokes `tmb_agent-creator` Branch C (headless auto-proceed via slash); writes `.claude/agents/data-engineer.md` from base template; `agent_register` + `audit_log(event_type='tmb_agent_created', mode='from-scratch')` |
| 2 | user | `/roundtable Should we use ClickHouse or PostgreSQL for our analytics warehouse? data-engineer + cto.\n\nDon't ask questions.` |
| → | bro | `roundtable_create(participants=['cto','data-engineer'])`; spawns both; each writes `discussion_append(kind='analysis')` and `roundtable_vote` |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | (1) `tmb_agent_created` audit row for `data-engineer` with `mode='from-scratch'`; (2) `data-engineer` in `agents` at `scope='project-local'`; (3) `roundtables` row count ≥1; (4) `discussions WHERE kind='analysis'` ≥2 (cto + data-engineer); (5) `roundtable_votes` rows where `voter` ∈ {`cto`, `data-engineer`} ≥2 |
| `outcome-coherence.json` | same writes confirmed |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `Skill`, `agent_list`, `agent_register`, `audit_log`, `Agent` (empty for the roundtable half — same caveat as before: bro doesn't reliably call MCP on resumed-slash sessions) |
| `tools-forbidden.json` | `task_create_batch` (deliberation isn't code work) |
| `cost-budget.json` | Soft 400K / 1200s (Branch C + 2-consultant roundtable is heavier than either alone) |

**Failure modes captured:**
- Bro tries Branch B for `data-engineer` (no matching template — should fall through to C)
- Bro halts Branch C in headless instead of auto-proceeding from the slash invocation (regression on SKILL.md §"Headless mode")
- Bro spawns only the templated `cto` (skipping the just-created `data-engineer`) — participant mismatch
- Either consultant fails to write `discussion_append(kind='analysis')` or `roundtable_vote`
- Bro auto-fires `roundtable_create` without the slash-invoke audit (slash-detect hook bug — same as the row-10/11 caveat from before)
