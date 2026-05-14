# 95-anonymous-cold-restart

**Regression test for**: GH issue #95 — Anonymous cold-session re-onboarding bug.

**Pre-state**: onboarded marker present in plugin_config (Anonymous), config done.

**Trigger**: `@bro hi` (cold session)

**Expected behavior**: bro's first-action chain reads onboarded marker → sees onboarded=true → skips onboarding → calls `issue_resume` → greets in plain second-person.

## Critical invariants (forbidden tools)

- NO `onboard_apply` — onboarding must NOT re-trigger
- NO `config_set` — config must NOT re-write

If either fires, the #95 regression has returned.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | onboarded marker still present (unchanged); plugin_config rows still present |
| `tools-required.json` | onboard_state_get + config_get + issue_resume (the standard first-action chain) |
| `tools-forbidden.json` | onboard_apply, config_set (re-onboarding markers) |
| `cost-budget.json` | Tight — cold restart should be ~5K tokens |
