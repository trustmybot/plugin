---
name: review-findings
description: Living list of patterns caught during code review. All agents internalize these before designing, implementing, or reviewing.
---

# Review Findings

Living list of bug patterns and anti-patterns caught during code review.
Every agent reads this before doing their job.

**How to use:**
- **Architect** — consult before writing task files to anticipate gaps
- **SWE** — consult before implementation to avoid known pitfalls
- **PR Reviewer** — add new findings here when you catch a recurring pattern

## Error Handling Gaps

(none yet — will be populated as bugs are caught)

## Concurrency / Race Conditions

(none yet)

## Input Validation

(none yet)

## State Management

(none yet)

## Performance Traps

(none yet)

## Test Isolation

(none yet)

## Language-Specific Patterns

Add sections as relevant to your stack (e.g., "Python Patterns", "React Patterns",
"SQL Patterns", "Go Patterns"). Each finding includes:

```markdown
### <Pattern name>
- **Caught in:** PR / commit / file:line
- **Symptom:** what went wrong
- **Root cause:** why
- **Rule:** generalized guidance for future work
- **Check:** how to detect in future reviews
```
