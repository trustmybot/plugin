# Naming — one stem per feature

A feature has **one canonical name stem**. Every surface that implements, tests, documents, or audits it uses that stem. No surface invents a parallel name.

## The rule

When you add or rename a feature, the stem matches across all of these:

| Surface | Pattern |
|---|---|
| Skill dir | `skills/tmb_<stem>/` |
| MCP tool | `<stem>_<verb>` (e.g. `cheatcode_search`) |
| MCP source / test | `src/tools/<stem>.ts`, `src/test/<stem>.test.ts` |
| Forked script | `scripts/<stem>-<verb>.sh` |
| Hook / integration test | `tests/**/<stem>-<verb>.test.sh` |
| L5/L6 row | `tests/l5-l6/rows/NN-<stem>/` |
| ADR / design doc | titled for `<stem>` |
| Audit `event_type` | `<stem>_<verb>` |
| Env / fixture vars | `TMB_<STEM>_*` |

## Why

A split stem — the v0.10.0 `cheatcode` skill shipping over a `resource_search` tool, `resource.ts`, and `resource-search.sh` — forces every reader to learn two names for one thing and hides the wiring. One stem makes the feature greppable: `git grep <stem>` returns the whole surface.

## Boundary

The stem names the *feature*, not a *domain word*. Generic uses (e.g. "resource" for per-spawn resource tracking, "3rd party" for the pr-reviewer) are not the feature and never get renamed. Scope any rename to the feature's identifiers — never a blanket `s/<word>/<stem>/`.

## Intentional exceptions

A stem doesn't need every surface — only the ones the feature actually has. A missing surface is not a violation when the feature is deliberately API-only.

- **`onboard`** is tools-only by design: `onboard_state_get` / `onboard_get_questions` / `onboard_apply` in `src/tools/onboard.ts`, driven by the `/onboard` command. There is no forked `scripts/onboard-*.sh` because the ceremony is pure MCP — the tool API is the only surface. Don't add one to "complete the pattern".

## Choosing a stem

Short, memorable, one concept. A vivid name (`cheatcode`) beats a generic one (`resource`): unique, greppable, and it sticks. Avoid words already used generically in the codebase.
