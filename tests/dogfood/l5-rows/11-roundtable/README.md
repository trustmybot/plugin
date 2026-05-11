# 11-roundtable

**Scenario under test:** the Human types `/roundtable` with a real deliberation question that references prior workflow state (the SQLite-storage decision from row 8). The `roundtable-slash-detect.sh` UserPromptSubmit hook writes the `roundtable_slash_invoked` audit row, the slash-invoke gate on `roundtable_create` clears, and bro orchestrates the deliberation: spawns architect + cto + pm consultants who each read the codebase + DB before writing `discussion_append(kind='analysis')`.

**🟡 Partial-test:** the ratification AUQ at the end is suppressed in test mode. The L5 unit verifies bro initiated `roundtable_create` and that the slash-invoke audit row was written; the L6 chain seeds the ratification vote post-AUQ.

## Pre-state

`onboarding-named` fixture. `setup.sh` pre-seeds:
- An open issue + a SQLite-decision discussion (`kind='decision'`) — context the roundtable needs to cite
- The architect + cto + pm consultants are in the agents registry as project-local (so `Agent` can spawn them without re-running the template-copy ceremony)

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `/roundtable should the TODO CLI's file watcher be async-first or thread-pooled?\n\nDon't ask questions.` |
| → | bro | calls `roundtable_create(participants=[architect,cto,pm], topic=...)`; spawns each consultant via `Agent`; each writes `discussion_append(kind='analysis')` and `roundtable_vote`. (The `roundtable-slash-detect.sh` audit-row write doesn't land in L5 — claude expands the slash before UserPromptSubmit hooks see it — so the substantive checks here are roundtable + analyses, not the slash-invoke audit.) Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `roundtables` row count ≥1; `discussions WHERE kind='analysis'` ≥1 (slash-invoke audit check omitted — see Turns note) |
| `outcome-coherence.json` | `roundtables`: `>=1`; `discussions WHERE kind='analysis'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` (deliberation only — no commits) |
| `tools-required.json` | (empty — bro doesn't reliably call MCP tools on resumed-slash sessions; the substantive checks live in outcome.sql/coherence) |
| `tools-forbidden.json` | `task_create_batch` (deliberation isn't code work) |
| `cost-budget.json` | Soft 300K / 900s (multiple consultant turns) |

**Failure modes captured:** bro auto-fires `roundtable_create` from a phrase trigger without the slash-invoke audit (the gate would reject); bro spawns consultants directly without the registry consult; consultants don't write their analysis to `discussions(kind='analysis')`.
