---
name: tmb_docs-conventions
description: Loaded when editing prompt files (agents, skills, CLAUDE.md, workflow markdown) or updating user-visible docs. Carries the editing judgment — what to delete, what to preserve, and where ripples land when a rename or restructure happens.
---

# Docs Conventions — Editing Discipline

When editing prompt files or user-visible docs, follow these rules.

## Docs-update expectation

When functionality changes, the same PR updates the user-visible docs that describe it. The PR-reviewer flags missing doc updates at the push gate. This is a judgment call (what counts as user-visible?).

## When docs and code disagree

If a doc you're updating contradicts the code, halt and surface it — pick the side that matches the intended behaviour, update the other, and flag the discrepancy first. Ground in the code itself (and the world model), not in the prose that describes it.

## Editing prompt files (agents, skills, CLAUDE.md, workflow markdown)

1. **Delete before you add.** A shorter prompt is usually clearer. Prefer removal over addition when both achieve the goal.
2. **Preserve operational meaning.** Copy constraints, prohibitions, and weighted examples verbatim — e.g. a `LOAD-BEARING-SAFETY` comment, a "HALT" rule, or an exact wire-format string — unless the request explicitly changes them.
3. **Match tone and structure.** Edits blend into the target file; they don't impose a different style.
4. **Stay in scope.** Correct what was asked; don't opportunistically rewrite adjacent content.
5. **Update referenced paths.** When you rename or move a file the prompt cites, grep for every reference and update it in the same commit.
6. **Diff, don't rewrite.** Produce edits as a focused diff unless a full rewrite was explicitly requested.

### Escalation

- Ambiguous rewrite request → ask specific questions, don't guess.
- Target file has internal contradictions → quote them, flag to the caller.
- Change would break files that reference this one → flag the ripple before proceeding.
