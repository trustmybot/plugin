# L5 + L6 — Row-based real-Claude harness

The heaviest, non-deterministic layers: they drive real Claude Code (`claude -p`) through user-language prompts and score the resulting MCP/tool sequence and DB state against doctrine. Both layers share one canonical row tree under [`rows/`](./rows/) — **L5** runs a row in isolation (applies its `setup-l5.ts`, or `setup-l5.sh` in rows not yet ported, to pre-seed prior state), **L6** walks the rows as a cumulative chain where state inherits from the prior step. See [`../README.md`](../README.md) for the testing philosophy and [`../EVALUATION.md`](../EVALUATION.md) for the scorer model.

> Test prompts (`rows/*/prompt.txt`) are Human-authored. Do not edit them to make a chain pass — fix the assertion, `setup-l5.ts` or `setup-l5.sh`, hook, or doctrine instead.

```bash
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l5.ts             # all rows in isolation
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l5.ts onboarding  # one row by name substring
node --experimental-strip-types --experimental-sqlite tests/l5-l6/run-l6-chain.ts       # full cumulative chain
```

| File / folder | Purpose |
|---|---|
| [`run-l5.ts`](./run-l5.ts) | Per-row isolated runner — applies `setup-l5.ts` (else `setup-l5.sh`), drives the prompt, runs scorers |
| [`run-l6-chain.ts`](./run-l6-chain.ts) | Multi-turn chain runner — walks the manifest rows against one cumulative trajectory DB |
| [`rows/`](./rows/) | The canonical row tree, organized into family folders `<NN>/` that hold the primary step `<NN>-<name>/` plus its edge cases `<NN>.<MM>-<name>/` (standalone `23-bulk-cleanup/` stays flat). Each leaf row dir holds `prompt.txt`, `script.json`, `fixture.txt`, an optional `setup-l5.ts` or `setup-l5.sh` (during the TypeScript port), `outcome.sql`, `tools-required.json`, `tools-forbidden.json`, `cost-budget.json`, and optional outcome bundles |
| [`l6-chain/`](./l6-chain/) | Chain configuration — `chain-manifest.json` (ordered steps) + `seeds/` (between-row SQL bridges). See its [`README.md`](./l6-chain/README.md) |
| [`lib/`](./lib/) | Shared TypeScript helpers, each tested by its `.test.ts` — flow and chain helpers, the row setup helpers ([`setup-helpers.ts`](./lib/setup-helpers.ts)), the scorers ([`scorers.ts`](./lib/scorers.ts)), sandbox, stubs, timeout |
| [`fixtures/`](./fixtures/) | SQL fixtures (`empty`, `onboarding-named`, `onboarding-anonymous`) that pre-seed the world-model-cold gate |
| [`inspect-trajectory.ts`](./inspect-trajectory.ts) | Helper to inspect a run's trajectory DB: `node --experimental-strip-types tests/l5-l6/inspect-trajectory.ts <project-dir>` |

## When a row fails

- **Fix at the trigger.** When a row flips, localize what triggers it (fixture text, seeded DB state, deny-message text, the row's own prompt) and fix there; a `prompt.txt` change needs Human approval. Never tune the shared TEST MODE preamble for one row: it reaches every row. A deny remedy an agent runs verbatim must be correct for the repo it names.
- **Classify from the run dir, not the summary table.** Read `<run-dir>/step-*/scorers.txt`, the tail of `bro-response.txt` and the token counts:

| Class | Signature | Action |
|---|---|---|
| Network kill | tokens ~0, connection error | Rerun |
| Judgment flake | passes at the same SHA elsewhere | Make the go-path deterministic |
| Regression | reproduces every run, green at the last rc | Fix |
