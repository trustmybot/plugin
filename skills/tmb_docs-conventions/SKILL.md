---
name: tmb_docs-conventions
description: Loaded when editing prompt files (agents, skills, CLAUDE.md, workflow markdown), updating user-visible docs, or writing or editing architecture or design docs. Carries the editing judgment and the three-layer rule — docs hold architecture, the world model holds relationships, code holds logic.
---

# Docs Conventions — Editing Discipline

When editing prompt files or user-visible docs, follow these rules.

## Three layers of knowledge

Every fact about the codebase lives in exactly one layer.

1. **Docs: architecture.** Components, their boundaries, the invariants they keep, and why they are built that way. A hand-written architecture or design doc never names a class, function, file, column or enum value; where a reader needs one, the doc points to the world model or the code. Usage docs that tell users which command or option to type may name those commands and options.
2. **World model: relationships.** What calls, reads or changes what, plus named design ideas tied to those symbols. `/scan` and swe's completion report generate it; it is never written by hand.
3. **Code: logic.** Self-explaining names and small units, so the code reads as its own description. A comment appears only for a why the code cannot show.

A fact in the wrong layer moves to the right one; it is never copied. The one exception is a generated section guarded by a test that fails when it goes stale. When a doc drifts from the code, delete the detail rather than re-copying it.

## Docs-update expectation

When functionality changes, the same PR updates the user-visible docs that describe it. A doc is user-visible when it names the changed command, option, flag or behaviour.

## When docs and code disagree

Ground in the code itself and the world model, not in the prose that describes it. When the spec says which side is intended, update the other and name the discrepancy in the report; otherwise change neither and raise it.

## Editing prompt files (agents, skills, CLAUDE.md, workflow markdown)

1. **Delete before you add.** A shorter prompt is usually clearer. Prefer removal over addition when both achieve the goal.
2. **Preserve operational meaning.** Copy constraints, prohibitions, and weighted examples verbatim — e.g. a `LOAD-BEARING-SAFETY` comment, a "HALT" rule, or an exact wire-format string — unless the request explicitly changes them.
3. **Match tone and structure.** Edits blend into the target file's existing style.
4. **Stay in scope.** Correct only what was asked and leave adjacent content as it is.
5. **Update referenced paths.** When you rename or move a file the prompt cites, grep for every reference and update it in the same commit.
6. **Edit as a focused diff.** Rewrite the whole file only when a full rewrite was explicitly requested.

### Escalation

In each case below, swe closes `failed` and quotes the question in its final message; bro asks the Human.

- The rewrite request is ambiguous — quote the ambiguous part.
- The target file contradicts itself — quote the contradiction.
- The change would break files that reference this one — name each file.
