# L6 chain — single chained integration

This directory holds the **L6 chain manifest** + **between-row seeds**. Each L5 row under `tests/l5-l6/rows/<NN>/` doubles as a chain step here — same outcome bundle, same fixtures, no duplication of scorer config.

## Layout

```
tests/l5-l6/l6-chain/
├── chain-manifest.json     # ordered step list + per-step seed paths
└── seeds/                  # between-row SQL bridges (post-AUQ pseudo-data)
    ├── after-01-cold-start.sql
    ├── after-03-reonboard-remote.sql
    ├── after-10-architectural-change.sql
    └── after-13-roundtable.sql
```

## Running

```bash
# Full chain (~$5–10, ~10 min)
bash tests/l5-l6/run-l6-chain.sh

# Resume from a specific row (e.g. after fixing a row-7 bug)
bash tests/l5-l6/run-l6-chain.sh --from 7

# Keep going past failures (instead of halting at first fail)
bash tests/l5-l6/run-l6-chain.sh --halt-on-fail 0
```

Per-step logs land under `~/.claude/tmb/l6-chain-runs/<run-id>/`:

```
<run-id>/
├── chain-summary.md          # row-by-row pass/fail + cost + duration
├── chain-trajectory.jsonl    # cumulative claude stream across all turns
└── step-NN-name/
    ├── pre-state.sql         # DB snapshot before this row fired
    ├── user-input.txt        # prompt sent this turn
    ├── bro-response.txt      # bro's last text block
    ├── tool-uses.jsonl       # bro's tool calls this turn
    ├── post-state.sql        # DB snapshot after the turn
    ├── post-state.diff       # pre→post text diff
    ├── scorers.json          # per-scorer pass/fail
    └── seed-applied.sql      # between-row seed if any (post-AUQ)
```

## How rows chain together

L5 runs each row alone against its fixture. L6 walks all 15 against ONE cumulative trajectory DB — each row fires a fresh `claude -p`, and bro picks up state from the DB via `tmb_recovery` / `issue_get_phase` / `task_first_actionable` on every cold start. Row N's DB writes are row N+1's pre-state — that's what the chain tests.

**Between-row seeds** bridge the AUQ gaps for partial-test rows (1, 2, 3, 13):

| After step | Seed applied | What it does |
|---|---|---|
| 1 cold-start | `after-01-cold-start.sql` | seeds `identity`, `plugin_config` defaults, `deep_scan_completed` audit |
| 3 reonboard-remote | `after-03-reonboard-remote.sql` | flips config to gitflow + GitHub + pr_target='dev' |
| 10 architectural-change | `after-10-architectural-change.sql` | records the chosen architectural conclusion as a `kind='decision'` discussion + ADR data |
| 13 roundtable | `after-13-roundtable.sql` | injects the human's ratify vote |

Rows 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15 are not partial-test — they progress purely on the DB writes bro made in earlier rows + their per-row `chain_setup_command` for any extra repo state.

## Adding a new row to the chain

1. Add the L5 row directory under its family folder `tests/l5-l6/rows/<NN>/`.
2. Append an entry to `chain-manifest.json`:
   ```json
   {
     "id": 16,
     "name": "16-new-step",
     "row_dir": "rows/16/16-new-step",
     "partial_test": false,
     "seed_before": null,
     "seed_after": null,
     "halt_on_fail": true
   }
   ```
3. If the row is partial-test and the chain needs a post-AUQ seed before the next row, add `seeds/after-16-new-step.sql` and reference it in `seed_after`.
4. Update the journey table in `tests/EVALUATION.md`.
