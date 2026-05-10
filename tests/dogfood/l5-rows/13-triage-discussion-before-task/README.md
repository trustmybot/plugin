# 13-triage-discussion-before-task

**Scenario under test:** for every code-touching ask, `tmb_planning` Step 1 mandates `discussion_append(kind='note', body='Triage: <simple|difficult>')` BEFORE `task_create_batch`. Production DB inspection (2026-05-09) showed **0 discussions across 9 issues** — bro consistently skipped the Triage write because no server gate enforces it (the scope-ambiguity gate is `kind='question'` based, not `kind='note'` based).

**Bug class — Daisy's framing:** *"Assume bro will violate every step."* The Triage discussion is a load-bearing audit trail; without it, future sessions can't see how the issue was classified.

## Pre-state

`onboarding-named` (gate pre-cleared via fixture seed).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro implement an add command for the TODO CLI in src/cli.py` |
| → | bro | `discussion_append(kind='intent', body='...')` + `discussion_append(kind='note', body='Triage: simple')` + `branch_id_propose` + `task_create_batch` + spawn SWE |
| 2 | user | `Wrap it up.` |
| → | bro | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a `discussions` row with `kind='note' AND body LIKE '%Triage%'` exists; tasks row count ≥1 |
| `outcome-coherence.json` | `discussions WHERE kind='note' AND body LIKE '%Triage%'`: `>=1`; `discussions WHERE kind='intent'`: `>=1`; `tasks`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `discussion_append`, `task_create_batch`, `Agent` |
| `tools-forbidden.json` | none |
| `cost-budget.json` | Soft 200K / 900s |

**Failure mode this captures:** bro fires `task_create_batch` directly (with the trivial-waive scope-gate path) and skips the upstream Triage write. Production data confirms this is the dominant skip.
