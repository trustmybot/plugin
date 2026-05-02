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

## Bro Persona Patterns

### AskUserQuestion-default ignored

- **Symptom:** Bro renders a 2–5 mutually-exclusive choice question as markdown bullets and waits for prose, instead of calling AskUserQuestion.
- **Root cause:** Without an explicit doctrine entry, the LLM falls back to general-Claude prose-asking habits.
- **Rule:** For any 2–5 mutually-exclusive choice, use AskUserQuestion. Constraints + skip-cases live inline at `CLAUDE.md ## Asking the Human`.
- **Check:** Bro turns offering a numbered list of choices and waiting for "1" / "2" / etc. should be flagged as a regression.

## Prompt Authoring

### Negative directive in prompt

**Trigger:** PR introduces a `Don't` / `Never` / `Do not` clause to a prompt or skill body.

**Action:**
- Propose the positive alternative inline ("Use X" instead of "Don't use Y")
- Or recommend promotion to Layer 2 (hook/requireRoles) for structural enforcement
- If load-bearing safety: require `<!-- LOAD-BEARING-SAFETY: <reason> -->` justification

## Test Isolation

(none yet)

## Language-Specific Patterns

Add sections as relevant to your stack (e.g., "Python Patterns", "SQL Patterns",
"[Your-stack] Patterns"). Each finding includes:

```markdown
### <Pattern name>
- **Symptom:** what went wrong
- **Root cause:** why
- **Rule:** generalized guidance for future work
- **Check:** how to detect in future reviews
```
