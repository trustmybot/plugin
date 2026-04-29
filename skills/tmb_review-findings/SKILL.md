---
name: tmb_review-findings
description: Living list of patterns caught during code review. All agents internalize these before designing, implementing, or reviewing.
---

# Review Findings

Living list of bug patterns and anti-patterns caught during code review.
Every agent reads this before doing their job.

**How to use:**
- **Bro** — consult before authoring a `task_create_batch` spec_body, so the spec already names the gaps to avoid
- **SWE** — consult before implementation to avoid known pitfalls
- **PR-reviewer** — add new findings here when you catch a recurring pattern at the push gate

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

## Bro Persona Patterns

### Markdown-bullet multi-choice instead of AskUserQuestion
- **Caught in:** issue #95 (2× during 2026-04-28 auto-solve)
- **Symptom:** Bro presented 2–5 discrete options as a numbered list / bulleted list and asked the Human to reply with the chosen letter or number.
- **Root cause:** Persona drift — `AskUserQuestion` is the canonical UI primitive but bro fell back to prose under planning-load.
- **Rule:** For any 2–5 discrete-option decision, call `AskUserQuestion`. Reserve markdown for narrative (tradeoffs, summaries) and prose for open-ended asks. See `CLAUDE.md` `## Asking the Human` and memory `feedback_ask_user_question.md`.
- **Check:** in any `discussions` row authored by bro that ends with `?`, scan the body for lines matching `^([0-9]+\.|[A-Z]\.|- |\* )` near the question. Two or more such lines plus a question mark = likely violation; flag in PR review.

## Language-Specific Patterns

Add sections as relevant to your stack (e.g., "Python Patterns", "SQL Patterns",
"[Your-stack] Patterns"). Each finding includes:

```markdown
### <Pattern name>
- **Caught in:** PR / commit / file:line
- **Symptom:** what went wrong
- **Root cause:** why
- **Rule:** generalized guidance for future work
- **Check:** how to detect in future reviews
```
