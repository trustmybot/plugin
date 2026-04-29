# 32-team-config

**Flow under test**: `tmb_reonboard` skill — switch policy keys (`branching_model` from github-flow → gitflow).

**Pre-state** (`onboarding-named`): identity set, `branching_model='github-flow'` (schema default).

**Trigger**: `@bro switch us to gitflow`

**Expected behavior** (headless-aware):
1. Bro recognises config-change trigger
2. Loads `tmb_reonboard`
3. Skill calls `AskUserQuestion`
4. **In headless mode (L5)**: AUQ errors → `tmb_headless-fallback` records `headless_reonboard_blocked`. (Interactive: `config_set` writes new value + `config_changed` event.)

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Ledger has either `config_changed` OR `headless_reonboard_blocked` |
| `tools-required.json` | `ledger_log` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Tight 40K / 60s |
