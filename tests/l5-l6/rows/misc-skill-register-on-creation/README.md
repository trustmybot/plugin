# skill-register-on-creation

**Scenario under test:** the Human asks bro to capture a project-local convention as a new skill. Bro must invoke the `tmb_skill-creator` skill, which writes the new skill via `skill_register` (and attaches it to the relevant agents' `skills:` frontmatter — out of scope for the DB-only assertion here).

**Bug class — #2853:** the `skills` table sits empty in production despite tmb_skill-creator being a documented flow. Without an L5 row exercising it, we have no regression net.

## Pre-state

`onboarding-named` fixture. No project-local skills yet. The 8 schema-seeded `tmb_*` rows (added by MR !151) are present with `created_by='system'`.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro create a project-local skill that documents our convention for tagging release commits with the Conventional Commits "release:" prefix. Don't ask questions.` |
| → | bro | invokes `tmb_skill-creator` → drafts `.claude/skills/<name>/SKILL.md` → calls `skill_register` writing a row to the `skills` table. Single turn — terminates after the register call returns. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | ≥1 row in `skills` with `created_by != 'system'` (bro-authored, not the schema-seeded ones) |
| `outcome-coherence.json` | `skills WHERE created_by != 'system'`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `skill_register` |
| `tools-forbidden.json` | none |
| `cost-budget.json` | Soft 200K / 600s |

**Failure modes captured:** bro drafts the SKILL.md file but never calls `skill_register`; bro calls `skill_register` with `created_by='system'` (would shadow the seeded rows); bro invokes the wrong tool (e.g. writes to a different table).

## Out of scope

- Asserting the actual SKILL.md file exists on disk (filesystem check is brittle in the multi-runner harness).
- The `agents[].skills[]` frontmatter wiring that `tmb_skill-creator` also performs.
- Multi-turn ratification flow (the prompt forbids questions to keep it single-turn).

## Verification status

**Authored but not yet run end-to-end against `claude -p`.** Reasoning: the assertions are correctness-by-construction (any successful `skill_register` call produces the `created_by != 'system'` row; the schema seed is fixed). Run via `bash tests/l5-l6/run-l5.sh misc-skill-register-on-creation` when you want a live signal.
