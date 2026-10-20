# 02.01-team-config

**Flow under test**: `/onboard slash command` skill — switch policy keys (`branching_model` from github-flow → gitflow).

**Pre-state** (`onboarding-named`): identity set, `branching_model='github-flow'` (schema default).

**Trigger**: `@bro I want to switch to gitflow — what's the right way to reconfigure?`

**Expected behavior**:
1. Bro recognises config-change trigger
2. Routes the Human to `/onboard` (a Human-triggered slash command — bro doesn't fire it itself)
3. **In test mode**: bro reads current config via `onboard_state_get` (the reonboard-intent hint's required first action), doesn't call AUQ, and tells the Human to run `/onboard`; policy stays unchanged. (Interactive: `/onboard`'s AUQ → `config_set` writes the new value + `config_changed` event.)

**L5 mode**: onboarding-named fixture provides identity; no extra pre-state.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | `branching_model` unchanged AND no `config_changed` event |
| `tools-required.json` | `onboard_state_get` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Tight 40K / 60s |