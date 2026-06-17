# L5 + L6 — Row-based real-Claude harness

The heaviest, non-deterministic layers: they drive real Claude Code (`claude -p`) through user-language prompts and score the resulting MCP/tool sequence and DB state against doctrine. Both layers share one canonical row tree under [`rows/`](./rows/) — **L5** runs a row in isolation (applies its `setup-l5.sh` to pre-seed prior state), **L6** walks the rows as a cumulative chain where state inherits from the prior step. See [`../README.md`](../README.md) for the testing philosophy and [`../EVALUATION.md`](../EVALUATION.md) for the scorer model.

> Test prompts (`rows/*/prompt.txt`) are Human-authored. Do not edit them to make a chain pass — fix the assertion, `setup-l5.sh`, hook, or doctrine instead.

```bash
bash tests/l5-l6/run-l5.sh                 # all rows in isolation
bash tests/l5-l6/run-l5.sh onboarding      # one row by name substring
bash tests/l5-l6/run-l6-chain.sh           # full cumulative chain
```

| File / folder | Purpose |
|---|---|
| [`run-l5.sh`](./run-l5.sh) | Per-row isolated runner — applies `setup-l5.sh`, drives the prompt, runs scorers |
| [`run-l6-chain.sh`](./run-l6-chain.sh) | Multi-turn chain runner — walks the manifest rows against one cumulative trajectory DB |
| [`rows/`](./rows/) | The canonical row tree — each `<NN>-<name>/` holds `prompt.txt`, `script.json`, `fixture.txt`, `setup-l5.sh`, `outcome.sql`, `tools-required.json`, `tools-forbidden.json`, `cost-budget.json`, and optional outcome bundles |
| [`l6-chain/`](./l6-chain/) | Chain configuration — `chain-manifest.json` (ordered steps) + `seeds/` (between-row SQL bridges). See its [`README.md`](./l6-chain/README.md) |
| [`lib/`](./lib/) | Shared shell helpers — flow/chain helpers, scorers, sandbox, stubs, timeout shim |
| [`fixtures/`](./fixtures/) | SQL fixtures (`empty`, `onboarding-named`, `onboarding-anonymous`) that pre-seed the world-model-cold gate |
| [`inspect-trajectory.sh`](./inspect-trajectory.sh) | Helper to inspect a run's trajectory DB |
