# 32-team-config

**Flow under test**: `/onboard slash command` skill — switch policy keys (`branching_model` from github-flow → gitflow).

**Pre-state** (`onboarding-named`): identity set, `branching_model='github-flow'` (schema default).

**Trigger**: `@bro I want to switch to gitflow — what's the right way to reconfigure?`

**Expected behavior**:
1. Bro recognises config-change trigger
2. Routes the Human to `/onboard` (a Human-triggered slash command — bro doesn't fire it itself)
3. **In test mode**: bro doesn't call AUQ; the documented default is to tell the Human to run `/onboard`, recorded as an audit/discussion `/onboard` mention. (Interactive: `/onboard`'s AUQ → `config_set` writes the new value + `config_changed` event.)

**L5 mode**: onboarding-named fixture provides identity; no extra pre-state.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Audit has `config_changed` OR `/onboard` routing |
| `tools-required.json` | `audit_append` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Tight 40K / 60s |