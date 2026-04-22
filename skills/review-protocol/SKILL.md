---
name: review-protocol
description: Review phases 1-7 for PR Reviewer. Progression from staged diff scan to full design compliance check.
---

# Review Protocol

Canonical task spec format: `docs/trustmybot/SPEC-FORMAT.md`.

## Phase 1 — Staged Diff Scan (Pre-Commit)

Check the diff for obvious issues:
- Lint errors (run the project's lint command)
- Test failures (run the project's test command)
- Syntax errors
- Incomplete implementations (empty function bodies, `TODO`, `FIXME`)
- Missing imports
- Dead code (unused variables, unreachable statements)

**If lint or tests fail:** stop and report as Critical.

---

## Phase 2 — Correctness

For each non-trivial change, trace through with concrete values:
- Happy path — does it produce correct output?
- Error path — are all failure modes handled?
- Boundary conditions — empty, null, max size, duplicate, negative, concurrent access

Cite exact line numbers. Show the input, the code path, the expected output, the actual output.

---

## Phase 3 — Design Compliance (if task spec provided)

Check implementation against the markdown task spec:
- `## Files` — are all specified files and functions changed?
- `## Success Criteria` — each criterion satisfied?
- `## Description` error-handling items — each has a code path?
- `## Out of Scope` — nothing forbidden was done?

Report gaps as Design Compliance findings (separate from severity).

---

## Phase 4 — Pattern Consistency

Does the new code match existing patterns?
- Naming conventions
- Error handling style
- Logging approach
- Test structure

Deviations should be flagged unless the task explicitly said to deviate.

---

## Phase 5 — Safety

- No hardcoded credentials
- No unsafe string interpolation into queries, commands, or URLs
- Resource cleanup (connections, file handles, subprocesses)
- Timeouts on network/subprocess operations
- Test isolation (no prod DB, no real API calls in unit tests)

---

## Phase 6 — Performance (if the task mentions it)

- O(n²) loops where O(n) would suffice
- N+1 query patterns
- Unnecessary allocations in hot paths

Only flag if the task's `## Success Criteria` mention performance.

---

## Phase 7 — Documentation

- Public API changes reflected in docs/types?
- Breaking changes flagged in CHANGELOG if one exists?
- Examples still compile/run?

---

## Sign-Off

After all phases pass, record the verdict via MCP:
```
validation_record(task_id=<id>, verdict='pass', notes='<summary>')
```

Then call `task_update_status(task_id=<id>, status='closed')`.

These MCP calls are the canonical sign-off mechanism — not file edits. The
SQLite row is the audit trail.

---

## Output

See `.claude/agents/pr-reviewer.md` for the full output format.
