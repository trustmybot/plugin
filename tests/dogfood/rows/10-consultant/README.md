# 10-consultant

**Scenario under test:** Two-phase test of `/tmb:agent-create` Branch B (template-copy) followed by a consultant spawn against actual code.

## Phase 1 — agent creation

Turn 1 prompt is `/tmb:agent-create cto`. Bro must invoke `tmb_agent-creator` (Branch B): copy `templates/agents/cto.md` to `.claude/agents/cto.md` → call `agent_register(scope='project-local')` → write a `tmb_agent_created` audit row → tell the Human the file landed. The `/plugin-reload` reminder is a contingency-only tail note (see SKILL.md §"Post-create reminder") and is NOT asserted by this row — `claude -p` test sessions have no second turn to act on it.

## Phase 2 — consultant evaluation

Turn 2 prompt asks cto to evaluate `src/auth.py` and recommend SQLite vs Postgres for the auth service. Bro spawns the just-created cto via `Agent`. cto reads the code and persists its analysis via `discussion_append(author='cto', kind='analysis')`.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` ensures `.claude/agents/cto.md` is absent (so Branch B runs) and seeds `src/auth.py` with SQLite/threading auth code for cto to evaluate.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/tmb:agent-create cto` |
| → | bro | invokes `tmb_agent-creator` Branch B; file lands at `.claude/agents/cto.md`; `agent_register` + `audit_log(event_type='tmb_agent_created')` |
| 2 | user | `Have cto evaluate src/auth.py — should we keep SQLite or move to Postgres for the auth service?\n\nDon't ask questions.` |
| → | bro | spawns cto via `Agent`; cto reads `src/auth.py`; persists analysis via `discussion_append(author='cto', kind='analysis')` |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `tmb_agent_created` audit row for cto; cto in `agents` at `scope='project-local'`; cto analysis in `discussions` |
| `outcome-coherence.json` | same 3 writes confirmed |
| `outcome-git.json` | `base_branch_unchanged: true` (consult — no code commits) |
| `tools-required.json` | `Skill`, `agent_list`, `agent_register`, `audit_log`, `Agent` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Soft 200K / 900s |
