---
name: tmb_feedback-loop
description: 3-question protocol for capturing bugs into review skills.
---

# Feedback Loop

Every bug caught after SWE submits is a system failure. Learn from it.

## When to Run

- PR review blocks a commit (reviewer found something SWE missed)
- Test failure from code change (regression)
- Human catches a bug
- Human asks bro to retry a failed SWE task

## Retry Protocol (failed task)

When the Human requests a retry on a failed task:

1. Read the failure details: `issue_get_with_discussions` to get the concern/failure discussion.
2. Append a retry-rationale discussion: `discussion_append(kind='decision', body='Retry rationale: <root cause> → <corrected approach>')`.
3. Create a **new** task via `task_create_batch` with a corrected spec that explicitly addresses the failure. The old failed task stays as evidence; the new task carries the corrected spec. Do NOT reset the old task's status.
4. Spawn SWE on the new task.
5. Log `audit_log(kind='event', event_type='planning_complete', summary='Retry task created with corrected spec.')`.

Then run the 3-question learning protocol below to capture the lesson.

## 3-Question Protocol

For each bug:

1. **Is this new or known?**
   - Check `skills/tmb_review-findings/SKILL.md` and `skills/tmb_code-quality/SKILL.md`
   - If already covered → agent ignored criteria
   - If NOT covered → gap, proceed to Q2

2. **Where should knowledge live?**
   - Specific code pattern → `skills/tmb_review-findings/SKILL.md`
   - Design-time question → `skills/tmb_code-quality/SKILL.md`
   - Implementation rule → `skills/tmb_code-quality/SKILL.md`

3. **Was the task underspecified?**
   - If SWE had to guess → update task template or quality checklist

## Format for New Entries

- tmb_review-findings.md: `- **[pattern name]** — [what happens]. [why wrong]. [what to do].`
- tmb_code-quality.md: `- [concise check — one line, actionable]`

## What NOT to Add

- One-off typos/formatting
- Platform/tooling issues (Docker, brew)
- Bugs from stale task files
