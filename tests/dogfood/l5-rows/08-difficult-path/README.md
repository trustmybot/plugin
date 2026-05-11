# 08-difficult-path

**Scenario under test:** the Human asks for a strategic stack-choice change ("rewrite our auth to use Clerk instead of homegrown JWT"). Per `tmb_planning` triage rules, this is a *difficult* path — bro must record `Triage: difficult`, run the Q+A loop, write a `kind='decision'` discussion, and author an ADR before dispatching SWE.

Passes in L5 standalone after the `skills/tmb_planning/SKILL.md` triage doctrine update (explicit "switch to X for auth/db/storage/framework → always difficult, casual phrasing doesn't downgrade"). In L6 chain bro sometimes still mis-classifies as `simple` due to cumulative-DB context priming — that's flake, not a deterministic regression.

## What this captures

`skills/tmb_planning/SKILL.md:53-55`:

> `simple` — narrow scope, no architecture impact, no public API change.
> `difficult` — touches `docs/trustmybot/architecture/`, introduces a new service boundary, modifies a public API, commits to a strategic stack choice, or names multiple unrelated surfaces.

Difficult-path also opens the **scope-ambiguity gate** (`task_create_batch` returns `forbidden` when there are zero `kind='question'` rows on the issue — see `skills/tmb_planning/SKILL.md:123`).

In `TMB_HEADLESS=1`, the Q+A loop is replaced by "proceed as proposed", but bro still must:
1. record `Triage: difficult` as a `kind='note'` discussion,
2. record at least one `kind='decision'` discussion,
3. author an ADR file at `docs/trustmybot/architecture/manual/decisions/N-*.md`.

The bug class this catches: bro misrouting a strategic-stack request as `simple` (skipping triage, skipping decision record, skipping ADR), or bypassing the difficult-path planning ceremony entirely.

## Pre-state

`onboarding-named` fixture. Empty repo (no auth code yet — bro shouldn't have to read existing files; the request is to introduce a new auth system).

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro let's switch to Clerk for auth.\n\nDon't ask questions.` |
| → | bro | triages as difficult, records `Triage: difficult` note, writes a `kind='decision'` discussion, authors ADR, dispatches SWE. Single turn — terminates when SWE close lands. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a `discussions` row with `kind='note'` + `body LIKE '%Triage: difficult%'`; at least one `kind='decision'` discussion |
| `outcome-coherence.json` | `discussions WHERE kind='decision'`: `>=1`; `tasks`: `>=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `discussion_append`, `task_create_batch`, `Agent` (SWE) |
| `tools-forbidden.json` | none |
| `cost-budget.json` | Soft 200K / 900s |
