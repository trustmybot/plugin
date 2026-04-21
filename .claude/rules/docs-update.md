---
paths:
  - "docs/**"
  - "README.md"
  - "CLAUDE.md"
---

# Documentation Update Rule

When functionality changes, update the corresponding documentation **in the
same PR**. Stale docs are worse than no docs — they actively mislead.

## What to update

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

## Rules

1. **Docs update in the SAME commit/PR as the code change.** Not "next PR" — same PR.
2. **If docs don't exist yet** and the change is non-trivial, create the doc.
3. **If a doc exists but is stale** and you're touching the related code,
   fix the doc in the same change.

## Enforcement

The PR Reviewer flags any commit that changes observable behavior without
updating the corresponding docs. "Observable" = anything a user, operator,
or downstream developer would notice.
