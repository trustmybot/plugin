# 13-roundtable

**Scenario under test:** the Human types `/roundtable` with a deliberation question about the todo CLI's storage choice (JSON vs SQLite vs small backend service). Bro orchestrates the deliberation: spawns cto + data-engineer (both already registered as project-local), each consultant reads context and writes `discussion_append(kind='analysis')` + a `roundtable_vote`.

**🟡 Partial-test:** the ratification AUQ at the end is suppressed in test mode. The L5 unit verifies bro initiated `roundtable_create` AND both pre-seeded participants contributed analyses + votes. The L6 chain seeds the ratification vote post-AUQ.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` pre-seeds:

- `src/cli.py` (TODO CLI with JSON storage) — the substrate the deliberation references
- `cto` (templated) registered as `scope='project-local'` (in L6 chain: comes from step 10's `/tmb:agent-create cto` ceremony)
- `data-engineer` (from-scratch consultant) registered as `scope='project-local'` with a minimal storage-architecture-focused body
- An open "TODO CLI storage choice" issue for the roundtable to cite

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/roundtable should the todo CLI's storage be JSON, SQLite, or a small backend service?\n\nDon't ask questions.` |
| → | bro | calls `roundtable_create(participants=['cto','data-engineer'], topic=...)`; spawns each consultant via `Agent`; each writes `discussion_append(kind='analysis')` AND `roundtable_vote`. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `roundtables` ≥1; `discussions WHERE kind='analysis'` ≥2 (one per participant); `roundtable_votes` includes both `cto` AND `data-engineer` |
| `outcome-coherence.json` | `roundtables`: `>=1`; `discussions WHERE kind='analysis'`: `>=2`; `roundtable_votes WHERE participant IN ('cto','data-engineer')`: `>=2` |
| `outcome-git.json` | `base_branch_unchanged: true` (deliberation only — no commits) |
| `tools-required.json` | `Agent` (the consultant spawns; bro doesn't reliably call MCP tools on resumed-slash sessions per #2854, so the substantive checks live in outcome.sql) |
| `tools-forbidden.json` | `task_create_batch` (deliberation isn't code work) |
| `cost-budget.json` | Soft 300K / 900s (multiple consultant turns) |

**Failure modes captured:** bro auto-fires `roundtable_create` without the slash-invoke audit (the gate would reject); bro spawns consultants directly without the roundtable structure; either consultant fails to write analysis or vote.
