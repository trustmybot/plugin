# 06-post-close-cleanup

**Scenario under test:** the Human asks bro about a file. Bro consults the world model (`world_model_get` / `world_model_search`) and then Reads the file directly. After bro's turn, the world model (kuzu graph DB) is still warm — the post-close-rescan hook refreshes it when bro_atomic_close fires.

## What this captures

After ADR 0002 (kuzu graph DB as world model), the world model lives in a sibling kuzu graph — not in SQLite. The `deep_scan_completed` audit row is the SQLite-side proxy for "world model warm." This row verifies the proxy persists after bro answers — either pre-seeded in setup-l5 (standalone) or populated by rows 04/05's scan + post-close-rescan in the L6 chain.

The bug class this catches: regressions that clear the world model or drop the audit row mid-flow.

## Pre-state

`onboarding-named` fixture + `README.md` + `src/cli.py` on disk. In L5 standalone, `setup-l5.sh` seeds a `deep_scan_completed` audit row + `repos` row (proxy for "world model warm"). In L6 chain, rows 04/05 already populated both.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro what does src/cli.py do? Just summarize it for me.\n\nDon't ask questions.` |
| → | bro | optionally consults `world_model_get`, then `Read("src/cli.py")`, then emits a concise summary in text. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `deep_scan_completed` audit row exists (proxy for kuzu world model warm) |
| `tools-required.json` | `Read` |
| `cost-budget.json` | Soft 200K / 900s |
