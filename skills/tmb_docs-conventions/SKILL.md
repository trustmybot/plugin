---
name: tmb_docs-conventions
description: When and how to update docs alongside code changes, plus the discipline for editing agent prompts and skill files.
---

# Docs Conventions

## Docs Update Rule

When functionality changes, update the corresponding documentation **in the
same PR**. Stale docs are worse than no docs — they actively mislead.

### What to update

| Change type | Update |
|---|---|
| New CLI command or flag | `README.md` (Usage section) |
| New API endpoint | `docs/api.md` (or equivalent) |
| New page or component | Relevant component/pages doc if one exists |
| New module or package | Project-level architecture doc |
| Permission or auth changes | `docs/security.md` or equivalent |
| DB schema changes | `docs/schema.md` or migration index |
| New config options | `README.md` (Configuration section) |
| Breaking changes | `CHANGELOG.md` (if one exists) |

### Rules

1. **Docs update in the SAME commit/PR as the code change.** Not "next PR" — same PR.
2. **If docs don't exist yet** and the change is non-trivial, create the doc.
3. **If a doc exists but is stale** and you're touching the related code,
   fix the doc in the same change.

### Enforcement

The PR Reviewer flags any commit that changes observable behavior without
updating the corresponding docs. "Observable" = anything a user, operator,
or downstream developer would notice.

## Architecture Docs Are the Source of Truth

### Rule

Agents must read architecture docs FIRST before exploring the codebase.
If the answer is in the docs, do NOT re-read source files.

When any feature changes the system design, DB schema, API routes, or service
architecture, the PR MUST update the corresponding architecture doc in the
same commit.

**If you discover a discrepancy between architecture docs and the actual
codebase, STOP and report it to the Bro.** Do not silently follow
stale docs or silently follow code that contradicts docs. The discrepancy
must be resolved — either the doc is updated or the code is wrong.

### What Must Be Documented

| Change Type | Update |
|---|---|
| New DB table or column | `docs/architecture/schema.md` (or equivalent) |
| New service or module boundary | `docs/architecture/overview.md` |
| New API endpoint | `docs/architecture/api.md` |
| Change in data flow or pipeline | `docs/architecture/dataflow.md` |
| New dependency on external service | `docs/architecture/dependencies.md` |
| Permission or access changes | `docs/architecture/permissions.md` |

### If Architecture Docs Don't Exist Yet

This is normal for new projects. For projects without architecture docs:
- Agents explore the codebase via `Grep`/`Read` as usual
- The first significant architectural change should also create the doc
- Smaller projects may live entirely in `README.md` and `CLAUDE.md`

### Enforcement

PR-reviewer flags architectural changes that don't update docs at push time. Bro escalates systemic discrepancies back to the Human during planning when it spots a doc/code mismatch.

## Editing Agent Prompts and Skill Files

When modifying `agents/*.md`, `skills/**/SKILL.md`, `CLAUDE.md`, or any
workflow markdown, follow the discipline below. Any agent touching prompt
files applies these rules. In TMB, that's SWE (when the task spec names a
markdown file).

### Scope

Markdown only. `src/`, `tests/`, or runtime-consumed config files are
off-limits for prompt-style edits. If a fix touches those paths, route via
bro → SWE (the standard task chain) instead of doing it inline.

### Rules

1. **Delete before you add.** A shorter prompt is usually clearer. Prefer
   removal over addition when both achieve the goal.
2. **Preserve operational meaning.** Constraints, prohibitions, and examples
   with operational or legal weight are copied verbatim unless the request
   explicitly changes them.
3. **Match tone and structure.** Edits blend into the target file; they do
   not impose a different style.
4. **Don't expand scope.** Correct what was asked; don't opportunistically
   rewrite adjacent content.
5. **Update referenced paths.** If you rename or move a file the prompt
   cites, grep for every reference and update it in the same commit.
6. **Diff, don't rewrite.** Produce edits as a focused diff unless a full
   rewrite was explicitly requested.

### Escalation

- Ambiguous rewrite request → return specific questions, don't guess.
- Target file has internal contradictions → quote them, flag to the caller.
- Change would break files that reference this one → flag the ripple before
  proceeding.
