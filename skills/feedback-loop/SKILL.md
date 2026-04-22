---
description: 3-question protocol for capturing bugs into review skills.
agent: architect, pr-reviewer, prompt-engineer
---

# Feedback Loop

Every bug caught after SWE submits is a system failure. Learn from it.

## When to Run

- PR review blocks a commit (reviewer found something SWE missed)
- Test failure from code change (regression)
- Human catches a bug

## 3-Question Protocol

For each bug:

1. **Is this new or known?**
   - Check `skills/review-findings.md` and `skills/code-quality.md`
   - If already covered → agent ignored criteria
   - If NOT covered → gap, proceed to Q2

2. **Where should knowledge live?**
   - Specific code pattern → `skills/review-findings.md`
   - Design-time question → `skills/code-quality.md`
   - Implementation rule → `skills/code-quality.md`

3. **Was the task underspecified?**
   - If SWE had to guess → update task template or quality checklist

## Format for New Entries

- review-findings.md: `- **[pattern name]** — [what happens]. [why wrong]. [what to do].`
- code-quality.md: `- [concise check — one line, actionable]`

## What NOT to Add

- One-off typos/formatting
- Platform/tooling issues (Docker, brew)
- Bugs from stale task files
