---
name: validation-protocol
description: Skeptical validation protocol for Architect after SWE completes. Covers output review, design compliance, PR reviewer gate, verdict, and feedback loop.
---

# Validation Protocol

Run after every SWE task completion. **Assume SWE's work is insufficient until
you prove otherwise.**

---

## Step 1 — SWE Output Review

1. Read SWE's `<results>` section — note gaps or suspiciously terse output
2. **Re-run** verification commands yourself (never rely on SWE's pasted output)
3. **Re-run** success criteria commands from the task file
4. Read every changed file. Check implementation matches the task — not just
   that it compiles.

---

## Step 2 — Design Compliance

Verify each task file section was fully implemented:
- Every error state from `<error-handling>` has a corresponding code path
- Every scenario from `<edge-cases>` is handled (count them — task says 5,
  code must have 5)
- Code follows patterns cited in `<context>` (not just "works" but "matches")
- No logic added that wasn't in the task (scope creep)
- No error states left as TODO or generic catch-all

---

## Step 3 — Safety Checks

- **Test isolation** — do tests use an isolated test environment? Never prod.
- **Query safety** — parameterized queries, no string interpolation in SQL
- **Connection management** — all resources closed properly
- **No hardcoded credentials** — URLs, API keys must come from env vars
- **Subprocess safety** — timeouts, no shell=True with dynamic input

---

## Step 4 — PR Reviewer Gate

Before any commit, spawn PR Reviewer:
- **Pre-commit (Gate 1):** Focused review of staged changes
- **Pre-push (Gate 2):** Comprehensive audit before push or PR creation

Every phase requires PR Reviewer pass — not just at the end.

---

## Step 5 — Write Verdict

```markdown
## Verdict
**Status:** PASS | FAIL | REVISION NEEDED
**Lint:** [pass/fail + output if fail]
**Tests:** [pass/fail + count + output if fail]
**Design Compliance:** [all error states handled? all edge cases covered?]
**Safety:** [test isolation OK? queries parameterized?]
**PR Review:** [summary of PR reviewer findings]
**Issues:** [if FAIL/REVISION: specific, actionable feedback referencing task file sections]
```

On FAIL: cite which task file section was violated. Re-spawn SWE. Max 3
retries, then escalate to Human.

---

## SWE Deception Patterns

Watch for:
- **"Lint passes" but only ran on one file** — check the full command
- **"All edge cases handled" but count doesn't match** — task file lists 5,
  code only handles 4. Count them.
- **Verification output suspiciously short** — one line instead of full output
  means task is INCOMPLETE
- **Empty except/catch blocks** — logs without re-raising or returning
- **"No changes needed" for a required section** — implementation MUST exist
- **Self-review checklist all checked, verification output empty** — reject
- **Scope creep masking omissions** — added unrequested features while quietly
  skipping a required edge case
- **"Tests pass" but only ran a subset** — check test count against the full suite
