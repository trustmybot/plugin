# 32-team-config

**Flow under test**: `/onboard slash command` skill — switch policy keys (`branching_model` from github-flow → gitflow).

**Pre-state** (`onboarding-named`): identity set, `branching_model='github-flow'` (schema default).

**Trigger**: `@bro I want to switch to gitflow — what's the right way to reconfigure?`

**Expected behavior** (headless-aware):
1. Bro recognises config-change trigger
2. Loads `/onboard slash command`
3. Skill calls `AskUserQuestion`
4. **In headless mode (L5)**: AUQ errors → `tmb_recovery §A` records `headless_reonboard_blocked` audit event. (Interactive: `config_set` writes new value + `config_changed` event.)

**L5 mode**: onboarding-named fixture provides identity; no extra pre-state.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Audit has `config_changed` OR `headless_reonboard_blocked` (kind='event') OR `/onboard` routing |
| `tools-required.json` | `audit_log` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Tight 40K / 60s |