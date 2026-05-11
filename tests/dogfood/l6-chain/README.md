# L6 chain — single chained integration

This directory holds the **L6 chain manifest** + **between-row seeds**. Each L5 row in `tests/dogfood/l5-rows/` doubles as a chain step here — same outcome bundle, same fixtures, no duplication of scorer config.

## Layout

```
tests/dogfood/l6-chain/
├── chain-manifest.json     # ordered step list + per-step seed paths
└── seeds/                  # between-row SQL bridges (post-AUQ pseudo-data)
    ├── after-01-cold-start.sql
    ├── after-03-reonboard-remote.sql
    ├── after-08-difficult-path.sql
    └── after-11-roundtable.sql
```

## Running

```bash
# Full chain (~$5–10, ~10 min)
bash tests/dogfood/run-l6-chain.sh

# Resume from a specific row (e.g. after fixing a row-7 bug)
bash tests/dogfood/run-l6-chain.sh --from 7

# Keep going past failures (instead of halting at first fail)
bash tests/dogfood/run-l6-chain.sh --halt-on-fail 0
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

L5 runs each row alone against its fixture. L6 walks all 13 in one continuous CC session via `claude --session-id` (turn 1) + `--resume` (subsequent turns) — row N's bro turn produces real DB writes that row N+1 inherits.

**Between-row seeds** bridge the AUQ gaps for partial-test rows (1, 2, 3, 8, 11, 13):

| After step | Seed applied | What it does |
|---|---|---|
| 1 cold-start | `after-01-cold-start.sql` | seeds `identity`, `plugin_config` defaults, `deep_scan_completed` audit |
| 3 reonboard-remote | `after-03-reonboard-remote.sql` | flips config to gitflow + GitLab + pr_target='dev' |
| 8 difficult-path | `after-08-difficult-path.sql` | injects `kind='question'` + `kind='answer'` rows for the Q+A loop |
| 11 roundtable | `after-11-roundtable.sql` | injects the human's ratify vote |

Rows 4, 5, 6, 7, 9, 10, 12 are not partial-test — they progress purely on the DB writes bro made in earlier rows + their per-row `setup.sh` for any extra repo state.

## Adding a new row to the chain

1. Add the L5 row directory under `tests/dogfood/l5-rows/`.
2. Append an entry to `chain-manifest.json`:
   ```json
   {
     "id": 14,
     "name": "14-new-step",
     "row_dir": "l5-rows/14-new-step",
     "partial_test": false,
     "seed_before": null,
     "seed_after": null,
     "halt_on_fail": true
   }
   ```
3. If the row is partial-test and the chain needs a post-AUQ seed before the next row, add `seeds/after-14-new-step.sql` and reference it in `seed_after`.
4. Update the journey table in `tests/EVALUATION.md`.
