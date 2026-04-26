# 01-onboarding

**Flow under test**: `FLOWS.md §1 — First-Run Onboarding`

**Pre-state** (`fixture-pre.sql` = empty): no identity, no config, no prior session.

**Trigger**: `@bro hi`

**Expected behavior**: bro detects empty state → invokes `tmb_first-run-onboarding` skill → AskUserQuestion → `identity_set` + 3x `config_set` + `ledger_log(tmb_onboarding_complete)`.

## Note on AskUserQuestion in `claude -p` mode

**Unverified upstream behavior** (per #108): if `AskUserQuestion` auto-fails in headless mode, the form-driven onboarding will short-circuit. The outcome scorer assertions tolerate this gracefully — they assert "if onboarding ran, it produced the right rows", not "the form was completed." If this flow consistently fails in CI, file a follow-up to either (a) document headless-mode skip, or (b) implement a non-form fallback for `claude -p`.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | identity row exists with non-null created_at; 3 plugin_config keys (branching_model, pr_target, protected_branches) present; `tmb_onboarding_complete` ledger event recorded |
| `tools-required.json` | identity_get + config_get probes called (the first-action chain) |
| `tools-forbidden.json` | (none — onboarding has no forbidden tools) |
| `cost-budget.json` | Soft budget |
