---
name: tmb_swe-checklist
description: SWE's self-review heuristics — load only when about to atomic-close. Mechanical patterns (bare except, missing timeout, mutable defaults, etc.) are caught by scripts/hooks/code-quality-lint.sh; this skill carries the spec-fidelity and scope discipline judgment.
---

# SWE Self-Review

Before `task_update_status(completed)`, confirm these by reading the diff.
Mechanical patterns (bare except, mutable defaults, etc.) are caught by
`scripts/hooks/code-quality-lint.sh` on every Edit/Write. You check the
things only a human reader would see.

- **Spec fidelity.** Every bullet under `## Files`, `## Success Criteria`, and
  every error/edge case named in `## Description` has a concrete change in
  the diff. Quote the bullet, point to the diff line.
- **Scope discipline.** Nothing changed outside `## Files` except trivial
  imports. No "while I was there" cleanups. No new TODOs.
- **Verification verbatim.** Ran the `## Verification` commands literally,
  not paraphrased. Pasted output proves they passed.
- **Worktree isolation.** Edits and commits all live inside the assigned
  worktree path; the main checkout is untouched.

Escalate (not guess) when:
- The spec contradicts itself — quote the contradiction.
- A required fact is missing from the spec — quote what's missing.
- 3 attempts at the same approach failed — show what you tried.
