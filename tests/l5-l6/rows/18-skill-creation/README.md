# 18-skill-creation

**Source:** L5 `05-skill-creation` (renumbered per reconciliation table).

**Scenario:** Bro is asked to create a skill for PR description conventions. `tmb_skill-creator` requires AskUserQuestion; the harness instructs bro not to call AUQ and to take the documented default, which for skill-creator is to HALT (file writes need Human approval) and record a creator-blocked audit event. Either outcome (skill created OR blocked) is a valid pass signal.

**L5 mode:** `setup-l5.sh` seeds `onboarding-named` state.
**L6 mode:** Not in chain manifest (standalone row).

## Scorers

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `tmb_skill_created` OR a `creator_blocked` audit event; skill created or bro halted |
| `tools-required.json` | `audit_append` |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Soft 60K / 90s |
