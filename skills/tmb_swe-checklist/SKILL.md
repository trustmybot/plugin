---
name: tmb_swe-checklist
description: Implementation rules and self-review checklist for SWE agent.
---

# SWE Checklist

## Before coding

- [ ] I have called `task_get(task_id)` and read the entire `spec_body`, not just the `description`/`title`
- [ ] The `spec_body` still has markdown H2 headings (Description, Files, Success Criteria, Verification, Out of Scope, Commit); I have parsed them as sections and acted on each
- [ ] I have read the existing files listed in `## Files` that I will modify
- [ ] I understand the patterns I need to match

## While coding

- [ ] I match existing patterns in the codebase (naming, error handling, test structure)
- [ ] Every error case mentioned in `## Description` has a corresponding code path
- [ ] Every edge case mentioned in `## Description` is handled
- [ ] I don't add features that weren't requested (scope creep)
- [ ] I don't add `TODO` or `FIXME` — the task is done or it's ESCALATE
- [ ] I use the project's standard logging, not `print` or `console.log`

## Before committing

- [ ] All `## Verification` commands pass (I ran them, not just assumed)
- [ ] No secrets, `.env` values, or credentials in the diff
- [ ] The commit message matches the `## Commit` section
- [ ] I am committing in the worktree, not the main repo

## Escalation criteria

Escalate (do NOT guess) if:
- The `spec_body` has a contradiction (quote it)
- Required context is missing from `spec_body` (quote what's missing)
- Tests fail in a way the task didn't anticipate (show output)
- 3 attempts at the same approach have failed (show what you tried)

## Anti-patterns to avoid

- Empty `except` / `catch` blocks without re-raising or returning meaningful error
- Broad `except Exception` when a specific exception is appropriate
- Printing/logging errors without propagating them
- Modifying tests to make them pass (tests describe intent — if you break one, you broke the feature)
- Adding defensive code the task didn't ask for (you're cluttering the diff)
- "Fixing" unrelated code you noticed (scope creep — escalate instead)
