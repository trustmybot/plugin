---
description: Post-roundtable cleanup steps.
agent: architect, bro
---

# Roundtable Cleanup Rule

After every roundtable meeting completes:

1. **Summarize** — Write a concise summary (max 1 page) capturing decisions, key arguments, and action items
2. **Save summary** — Replace the raw discussion file in `docs/trustmybot/roundtable/` with the summary
3. **Delete raw content** — The full meeting transcript must NOT be kept. Other agents should never have to read a full roundtable discussion — it's too long and wastes context.

## Why

- Raw roundtable files grow unbounded and bloat the repo
- Other agents reading full meetings wastes context window on repetitive debate
- Only decisions and rationale matter after the meeting ends

## Format for summaries

```markdown
# [Topic] — Roundtable Summary

**Date:** YYYY-MM-DD
**Participants:** [agents]
**Decision:** [one-line verdict]

## Key Arguments
- [bullet points, max 5]

## Action Items
- [ ] [concrete next steps]
```

Keep summaries under 50 lines. If a roundtable produced a separate deliverable (e.g., DESIGN-PLAN.md), reference it instead of duplicating content.
