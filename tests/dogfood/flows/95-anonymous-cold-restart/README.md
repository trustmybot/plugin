# 95-anonymous-cold-restart

**Regression test for**: GH issue #95 — Anonymous cold-session re-onboarding bug.

**Pre-state**: identity row exists with `human_name=NULL` (Anonymous), config done.

**Trigger**: `@bro hi` (cold session)

**Expected behavior**: bro's first-action chain reads identity row → sees non-null `created_at` → skips onboarding → calls `issue_resume` → greets in plain second-person.

## Critical invariants (forbidden tools)

- NO `identity_set` — onboarding must NOT re-trigger
- NO `config_set` — config must NOT re-write

If either fires, the #95 regression has returned.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | identity row count is still 1 (unchanged); 3 plugin_config rows still present |
| `tools-required.json` | identity_get + config_get + issue_resume (the standard first-action chain) |
| `tools-forbidden.json` | identity_set, config_set (re-onboarding markers) |
| `cost-budget.json` | Tight — cold restart should be ~5K tokens |
