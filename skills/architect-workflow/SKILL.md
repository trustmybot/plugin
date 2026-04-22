---
name: architect-workflow
description: Feature workflow protocol for Architect. Covers issue/discussion/task lifecycle, MCP state capture, and SWE coordination.
---

# Architect Workflow

Workflow files live in `docs/trustmybot/` at the project root.
Canonical task spec format: `docs/trustmybot/SPEC-FORMAT.md`.

## File Format Rules

| File | Format | Audience | Rationale |
|---|---|---|---|
| `docs/trustmybot/tasks/<branch_id_filename>.md` | Markdown frontmatter + body | Architect → SWE | Structured contract readable by both agents and humans |

---

## Workflow Steps

1. Create or resume MCP issue (`issue_create` or `issue_resume`) to anchor the work item.
2. Discuss via `discussion_append` until aligned with the Human — append `kind='question'` entries, read replies, iterate.
3. Author markdown task specs per `docs/trustmybot/SPEC-FORMAT.md`.
4. Call `task_create_batch` + `task_set_spec_path` to register specs in SQLite.
5. Spawn SWE per task (one worktree per task).
6. Validate per `skills/validate-swe-output.md`.
7. Spawn PR Reviewer before reporting phase complete.
8. Close tasks via `task_update_status(status='closed')` once review passes.

**Loops until all tasks are closed.** After step 7, check for remaining open
tasks → return to step 2.

### Intent Change Mid-Workflow

If the Human revises intent mid-workflow, append a new
`discussion_append(kind='intent')` entry; re-evaluate the open task batch and
split / cancel as needed via `task_update_status`. Optionally generate a
snapshot via `issue_snapshot_md` when the Human wants a doc to review.

---

## Discussion Phase

1. Call `issue_resume` or `issue_create` to load context.
2. Explore the codebase — identify affected modules, read existing code paths
   (error handling, validation, patterns).
3. Append analysis + questions via `discussion_append(kind='question')`
   (max 3-4 questions per round).
4. Wait for Human replies; load them via `discussion_get` or from the
   conversation thread.
5. When aligned: **ALIGNED — PRODUCING TASK SPECS**

**Never skip discussion.** Explore code BEFORE asking questions.

---

## Reasoning Process

**A. Requirement Alignment** — Load issue context, identify affected files,
separate explicit from implied, flag scope risks.

**B. Code Exploration** — Read actual code, not file names. For each area:
existing implementation, adjacent features (patterns), consumers of changed
functions, test files. Document findings as `file:line — [pattern]`.

**C. Solution Design** — Consider 2+ approaches. For each: error states,
edge cases, validation, state implications.

**D. Design Review** — Run quality criteria against each proposed task batch.

**E. Efficiency** — Minimize tasks. Group related changes. Mark parallelizable
tasks. Sequence by `depends_on`.

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

> SWE spawn rules (worktree isolation, task spec template, parallel execution):
> `skills/swe-spawn-workflow/SKILL.md`
