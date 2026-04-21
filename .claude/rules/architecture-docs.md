---
paths:
  - "docs/architecture/**"
  - "CLAUDE.md"
---

# Architecture Docs Are the Source of Truth

## Rule

Agents must read architecture docs FIRST before exploring the codebase.
If the answer is in the docs, do NOT re-read source files.

When any feature changes the system design, DB schema, API routes, or service
architecture, the PR MUST update the corresponding architecture doc in the
same commit.

**If you discover a discrepancy between architecture docs and the actual
codebase, STOP and report it to the Secretary.** Do not silently follow
stale docs or silently follow code that contradicts docs. The discrepancy
must be resolved — either the doc is updated or the code is wrong.

## What Must Be Documented

| Change Type | Update |
|---|---|
| New DB table or column | `docs/architecture/schema.md` (or equivalent) |
| New service or module boundary | `docs/architecture/overview.md` |
| New API endpoint | `docs/architecture/api.md` |
| Change in data flow or pipeline | `docs/architecture/dataflow.md` |
| New dependency on external service | `docs/architecture/dependencies.md` |
| Permission or access changes | `docs/architecture/permissions.md` |

## If Architecture Docs Don't Exist Yet

This is normal for new projects. For projects without architecture docs:
- Agents explore the codebase via `Grep`/`Read` as usual
- The first significant architectural change should also create the doc
- Smaller projects may live entirely in `README.md` and `CLAUDE.md`

## Enforcement

PR Reviewer flags architectural changes that don't update docs. The Architect
escalates systemic discrepancies back to Human.
