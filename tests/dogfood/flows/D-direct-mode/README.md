# D-direct-mode

**Flow under test**: `FLOWS.md §D — Direct Mode (narrow bypass for trivial single-file changes)`

**Pre-state**: onboarding complete + a README.md with a typo to fix.

**Trigger**: `@bro fix the typo 'recieve' to 'receive' in README.md`

**Expected behavior**: bro detects ≤3-line single-file scope → Direct Mode → `Edit` + `Bash(git commit)` + `ledger_log(direct_mode_used)`.

## Critical invariants (forbidden tools)

- NO `task_create_batch` — Direct Mode skips planning
- NO `Task` (SWE spawn) — Direct Mode skips execution handoff
- NO `validation_record` — pr-reviewer-only

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Exactly one `direct_mode_used` ledger event; no tasks created |
| `tools-required.json` | `Edit`, `Bash`, `ledger_log` all called |
| `tools-forbidden.json` | `task_create_batch`, `Task`, `validation_record` NOT called (the load-bearing Direct Mode discipline) |
| `cost-budget.json` | Tight — Direct Mode should be cheap (<10K tokens) |
