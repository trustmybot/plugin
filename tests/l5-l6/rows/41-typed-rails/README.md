# 41-typed-rails

**Flow under test**: Typed Rails (#673) — `files`/`verification` are typed, schema-validated columns on `tasks`, not markdown scraped from `spec_body`. A code-touching ask flows through `task_create_batch`, and every created task row carries the typed `files`/`verification` columns as valid JSON arrays.

bro's emission of non-empty typed fields lives in the `tmb_planning` skill (sibling Task B, prompt-surface) and ships in the same PR-set. This row asserts the mechanism end-to-end at the storage layer: the columns exist and hold JSON arrays regardless of whether bro populated them yet (clean break — the default is `'[]'`, never a markdown fallback).

**Pre-state** (`onboarding-named`): identity set, no tasks. State stubbed; no extra pre-state.

**Trigger**: `@bro write a python cli todo`

**Expected behavior**:
1. Bro triages as simple, creates an issue + task via `task_create_batch`.
2. The created task row carries the typed `files` and `verification` columns.
3. Each column holds a valid JSON array (default `[]`, or a non-empty array bro emitted) — never markdown prose.

**L5 mode**: `onboarding-named` fixture seeds identity; `setup-l5.sh` adds no extra pre-state.
**L6 mode**: standalone row, not in the chain manifest.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | ≥1 task; every task's `files` + `verification` are valid JSON arrays |
| `outcome-coherence.json` | ≥1 task, ≥1 issue written |
| `outcome-git.json` | base branch unchanged |
| `tools-required.json` | `task_create_batch`, `issue_create` |
| `tools-forbidden.json` | `validation_record` NOT called |
| `cost-budget.json` | Soft 60K / 90s |
