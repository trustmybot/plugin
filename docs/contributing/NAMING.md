# Naming — one stem per feature

A feature has **one canonical name stem**. Every surface that implements, tests, documents, or audits it uses that stem. No surface invents a parallel name.

## The rule

When you add or rename a feature, the stem carries across its surfaces in each surface's own case: `skills/tmb_<stem>/` for a skill, `<stem>_<verb>` for MCP tools and audit event types, `<stem>[-<verb>]` for TypeScript source and test files, `TMB_<STEM>_*` for env vars. `cheatcode` is the model: the `tmb_cheatcode` skill, the `cheatcode_*` tools and events, `src/tools/cheatcode-*.ts` and `src/test/cheatcode-*.test.ts`.

## Why

A split stem — the v0.10.0 `cheatcode` skill shipping over a `resource_search` tool and `resource.ts` — forces every reader to learn two names for one thing and hides the wiring. One stem makes the feature greppable: `git grep <stem>` returns the whole surface.

## Boundary

The stem names the *feature*, not a *domain word*. Generic uses (e.g. "resource" for per-spawn resource tracking, "3rd party" for the code-reviewer) are not the feature and never get renamed. Scope any rename to the feature's identifiers — never a blanket `s/<word>/<stem>/`.

## Choosing a stem

Short, memorable, one concept. A vivid name (`cheatcode`) beats a generic one (`resource`): unique, greppable, and it sticks. Avoid words already used generically in the codebase.

## Checks

The stem rule is held in review; no lint checks it across surfaces. Two lints hold the skill names: [`skill-frontmatter.test.mjs`](../../tests/l1-lint/skill-frontmatter.test.mjs) (a `SKILL.md` `name` equals its directory) and [`skill-catalog-sync.test.mjs`](../../tests/l1-lint/skill-catalog-sync.test.mjs) (the skill directories and the builtin-skill seed rows in `schema.sql` are the same set).

## Intentional exceptions

`onboard` has no `tmb_onboard` skill: the Human runs the `/onboard` command (`commands/onboard.md`), and the `onboard_*` MCP tools (`onboard.ts`) drive every round. The stem still carries across the command, tools and source.
