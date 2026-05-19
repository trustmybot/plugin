# example-claude-md-slim

Worked example for the A/B framework. Demonstrates the file layout and runner without claiming to test a real hypothesis.

## Layout

```
example-claude-md-slim/
├── scenario.json           — flow + prompt + arm list
├── arms/
│   ├── A-slim/             — empty (uses the plugin's current CLAUDE.md as-is)
│   └── B-padded/
│       └── CLAUDE.md       — verbose stand-in with same rules + rationale paragraphs
└── README.md               — this file
```

## How the runner uses this

1. `bash tests/dogfood/run-ab.sh example-claude-md-slim` reads `scenario.json`
2. For each pair (default 5):
   - Sets up a scratch project (per `l5_setup_scratch_project`)
   - For arm `A-slim`: copies `$PLUGIN_ROOT` to a temp dir, overlays `arms/A-slim/` (empty → no override), runs `claude --plugin-dir <temp> -p "<prompt>"`, scores per `tests/dogfood/rows/95-anonymous-cold-restart/` configs, tags eval_results rows with `arm='A-slim', scenario='example-claude-md-slim'`
   - For arm `B-padded`: same but `arms/B-padded/CLAUDE.md` overrides the plugin's CLAUDE.md
3. After all pairs: `bash tests/dogfood/scripts/ab-report.sh example-claude-md-slim` aggregates pass-rates per arm + chi-squared p-value per scorer

## Real scenarios go in #153

This is a template. The actual hypothesis testing (CLAUDE.md slim vs pre-slim, Hybrid D' vs always-lazy, etc.) lives in #153 once the framework is proven.

## Running

```bash
export CLAUDE_CODE_OAUTH_TOKEN=<your-token>
N=10 bash tests/dogfood/run-ab.sh example-claude-md-slim
bash tests/dogfood/scripts/ab-report.sh example-claude-md-slim --db /path/to/persisted/trajectory.db
```

Note: scratch DBs are deleted between runs. To retain results for reporting, set `L5_KEEP_ARTIFACTS=1` and point ab-report at one of the surviving DBs (or merge them — see scripts dir for future helpers).
