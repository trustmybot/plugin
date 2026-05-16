# 05-skill-creation

**Flow under test**: `tmb_skill-creator` skill — generate a project-local skill file and attach to agents.

**Pre-state** (`onboarding-named`): identity set, no skills under `.claude/skills/`.

**Trigger**: `@bro create a skill that codifies our convention for writing PR descriptions: TLDR + bullets + test plan`

**Expected behavior** (headless-aware):
1. Bro routes to `tmb_skill-creator`
2. Skill calls `AskUserQuestion`
3. **In headless mode (L5)**: AUQ errors → `tmb_recovery §A` records `headless_creator_blocked` audit event. (Interactive: writes skill file + emits `tmb_skill_created`.)

## Scorers

| Scorer | What it asserts |
|---|---|
| `outcome.sql` | Audit has either `tmb_skill_created` OR `headless_creator_blocked` (kind='event') |
| `tools-required.json` | `audit_log` (audit on either path) |
| `tools-forbidden.json` | `task_create_batch`, `validation_record` |
| `cost-budget.json` | Soft 60K / 90s |

## Why both outcomes are valid

L5 runs `claude -p` headlessly. The graceful-degradation contract is what we test — bro must not halt, must not fabricate, must record the block.
