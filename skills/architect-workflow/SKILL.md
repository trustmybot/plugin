---
name: architect-workflow
description: Feature workflow protocol for Architect. Covers GOALS through BLUEPRINT, discussion phase, and task lifecycle.
---

# Architect Workflow

Workflow files live in `docs/trustmybot/` at the project root.

## File Format Rules

| File | Format | Audience | Rationale |
|---|---|---|---|
| `docs/trustmybot/GOALS.md` | Markdown | Human → Architect | Human writes and reads naturally |
| `docs/trustmybot/DISCUSSION.md` | Markdown | Architect ↔ Human | Conversational alignment |
| `docs/trustmybot/BLUEPRINT.md` | Markdown | Architect → Human | Human reviews and approves |
| `docs/trustmybot/tasks/*.xml` | XML | Architect → SWE | Structured contract, no ambiguity |

---

## Workflow Steps

1. Read `docs/trustmybot/GOALS.md`
2. **Discuss** with Human via `docs/trustmybot/DISCUSSION.md` until aligned
3. Produce `docs/trustmybot/BLUEPRINT.md` — run Design Review before presenting
4. Wait for Human approval
5. Write per-task execution plans to `docs/trustmybot/tasks/` as XML
6. Spawn SWE per task, validate per `validation-protocol.md`
7. Spawn PR Reviewer before reporting phase complete
8. **Close completed goals** — wrap in `<closed reason="...">` tags in GOALS.md

**Loops until all goals are closed.** After step 7, check for remaining open
goals → return to step 2.

### GOALS.md Change Detection

When Human edits GOALS.md mid-workflow:
1. Re-read GOALS.md immediately
2. Compare against current DISCUSSION/BLUEPRINT
3. New/changed goals → return to step 2
4. Removed goals → acknowledge in DISCUSSION.md, drop from BLUEPRINT

---

## Discussion Phase

1. Read GOALS.md and explore the codebase
2. Identify affected modules and files
3. Read existing code paths — error handling, validation, patterns
4. Write analysis + questions to `docs/trustmybot/DISCUSSION.md` (max 3-4 questions)
5. Human answers below `---ANSWER-BELOW---` marker
6. When aligned: **ALIGNED — PRODUCING BLUEPRINT**

**Never skip discussion.** Explore code BEFORE asking questions.

### DISCUSSION.md Format

Each question is self-contained, separated by `---`. Every question gets its
own `---ANSWER-BELOW---` marker. Human answers under each marker independently.

```markdown
### Q1: [Title]

[Analysis, options, trade-offs, recommendation]

---ANSWER-BELOW---

---

### Q2: [Title]

[Analysis, options, trade-offs, recommendation]

---ANSWER-BELOW---
```

**Never** put a single `---ANSWER-BELOW---` at the bottom for all questions.

---

## Reasoning Process

**A. Requirement Alignment** — Read GOALS, identify affected files, separate
explicit from implied, flag scope risks.

**B. Code Exploration** — Read actual code, not file names. For each area:
existing implementation, adjacent features (patterns), consumers of changed
functions, test files. Document findings as `file:line — [pattern]`.

**C. Solution Design** — Consider 2+ approaches. For each: error states,
edge cases, validation, state implications.

**D. Design Review** — Run quality criteria against each blueprint phase.

**E. Efficiency** — Minimize phases. Group related changes. Mark parallelizable
tasks. Sequence by dependency.

---

## BLUEPRINT Format — STAR

```markdown
## Phase N: [Title]
**Depends:** [none | phase_N]
**Situation:** Current state — what exists, what's broken. Cite file:line.
**Task:**      What and WHY (name the object, not the activity)
**Action:**    Ordered steps with file paths and commands
**Result:**    Acceptance criteria — exact verification commands
**Pitfalls:**  Specific failure modes to avoid
**Error Handling:** Error → response/behavior map
**Edge Cases:** Scenarios with expected behavior
**Checkpoint:** Falsification test before next phase
**Rollback:**  How to undo
```

---

> SWE spawn rules (worktree isolation, task XML template, parallel execution):
> `skills/swe-spawn-workflow/SKILL.md`
