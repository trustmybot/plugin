# 95-anonymous-cold-restart

**Regression test for**: GH issue #95 — Anonymous cold-session re-onboarding bug.

**Pre-state**: `onboarding-anonymous` fixture — onboarded marker present, no name stored.

**Trigger**: `@bro hi` (cold session)

**Expected behavior**: bro's first-action chain reads onboarded marker → sees onboarded=true → skips onboarding → calls `issue_resume` → greets in plain second-person.

**Critical invariants (forbidden tools)**:
- NO `onboard_apply` — onboarding must NOT re-trigger
- NO `config_set` — config must NOT re-write

**L5 mode**: `fixture.txt` = `onboarding-anonymous`; no extra pre-state.
**L6 mode**: standalone row, not in chain.

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | onboarded marker still present; plugin_config rows still present; no audit events |
| `tools-required.json` | empty |
| `tools-forbidden.json` | `onboard_apply`, `config_set` |
| `cost-budget.json` | Tight 8K / 10s — cold restart with seeded identity is cheapest possible turn |