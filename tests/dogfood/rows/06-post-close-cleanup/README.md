# 06-post-close-cleanup

**Scenario under test:** the Human asks bro about a file. Bro consults the world model (`world_model_get` / `world_model_search`) and then Reads the file directly. After bro's turn, the world model substrate is still warm — `directories` rows persist for the project.

## What this captures

After ADR 0001 (schema v7), per-file summary state is gone. The world model is what stays warm across sessions. This row verifies the substrate continues to be populated after bro answers — either pre-warmed in setup-l5 (standalone) or populated by rows 04/05's scan + post-close-rescan in the L6 chain.

The bug class this catches: regressions that empty `directories` mid-flow (e.g. a bad rescan that wipes summaries, or a migration that drops the table).

## Pre-state

`onboarding-named` fixture + `README.md` + `src/cli.py` on disk. In L5 standalone, `setup-l5.sh` pre-warms `directories` with a README-derived summary for the repo root. In L6 chain, rows 04/05 already populated the table.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro what does src/cli.py do? Just summarize it for me.\n\nDon't ask questions.` |
| → | bro | optionally consults `world_model_get`, then `Read("src/cli.py")`, then emits a concise summary in text. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `directories` has ≥1 populated row |
| `outcome-coherence.json` | `directories WHERE summary IS NOT NULL`: `>=1` |
| `tools-required.json` | `Read` |
| `cost-budget.json` | Soft 200K / 900s |
