---
name: tmb_docs-conventions
description: Discipline rules for editing prompt files (agents, skills, CLAUDE.md, workflow markdown) and the docs-update expectation. Mechanical link-rot and architecture-doc-drift checks live in tests/lint/link-check.sh.
---

# Docs Conventions — Editing Discipline

Mechanical link integrity is enforced by `tests/lint/link-check.sh`. This skill carries the editing judgment — what to delete, what to preserve verbatim, where the ripples go when a rename or restructure lands.

## Docs-update expectation

When functionality changes, the same PR updates the user-visible docs that describe it. The PR-reviewer flags missing doc updates at the push gate. This is a judgment call (what counts as user-visible?) — not a regex check.

## When docs and code disagree

If a doc you're updating contradicts the code, halt and surface it — pick the side that matches the intended behaviour, update the other, and flag the discrepancy first. Ground in the code itself (and the world model), not in the prose that describes it.

## Editing prompt files (agents, skills, CLAUDE.md, workflow markdown)

When the task spec names a markdown file under `agents/`, `skills/`, `CLAUDE.md`, or any workflow markdown, apply these rules. They are the hardest-won discipline in the project: a sloppy prompt edit can swing every agent's behaviour next session.

1. **Delete before you add.** A shorter prompt is usually clearer. Prefer removal over addition when both achieve the goal.
2. **Preserve operational meaning.** Constraints, prohibitions, and examples with operational or legal weight are copied verbatim unless the request explicitly changes them.
3. **Match tone and structure.** Edits blend into the target file; they don't impose a different style.
4. **Stay in scope.** Correct what was asked; don't opportunistically rewrite adjacent content.
5. **Update referenced paths.** When you rename or move a file the prompt cites, grep for every reference and update it in the same commit.
6. **Diff, don't rewrite.** Produce edits as a focused diff unless a full rewrite was explicitly requested.

### Escalation

- Ambiguous rewrite request → ask specific questions, don't guess.
- Target file has internal contradictions → quote them, flag to the caller.
- Change would break files that reference this one → flag the ripple before proceeding.
