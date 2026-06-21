# 15-search-grounding

**Scenario under test:** the Human asks bro why a prior architectural decision was made in `src/cli.py`. Bro must use `discussion_search` to ground the answer in the step 08 ADR decision rather than hallucinating from context. A `kind='decision'` discussion seeded by step 08 (or by `setup-l5.sh` in L5 isolation) is the only source of truth.

The `discussions_embeddings` table is pre-seeded with a deterministic stub vector (zeros) for the decision row so keyword + hybrid search return it without a real ONNX embedding call.

## Pre-state

- `src/cli.py` exists with the storage-backend refactor from step 08.
- A `kind='decision'` discussion exists (step 08's ADR content) with a corresponding `discussions_embeddings` row (stub vector — deterministic).
- No real ONNX model needed; the stub vector ensures the DB-level cosine lookup returns the seeded row.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro why did we choose to extract storage into a backend interface in src/cli.py?` |
| → | bro | calls `discussion_search` to ground the answer in the recorded decision; cites the ADR body. No code work. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `discussions_embeddings` ≥ 1 row (seeded by setup-l5.sh or step 08 organically) |
| `outcome-coherence.json` | `discussions_embeddings`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `discussion_search` |
| `tools-forbidden.json` | `task_create_batch` (no code work) |
| `cost-budget.json` | Soft 200K / 600s |

**Failure modes captured:** bro answers from LLM memory without calling `discussion_search`; bro calls `task_create_batch` (incorrectly treats a knowledge question as a code task).
