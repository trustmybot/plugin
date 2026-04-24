---
name: architect-workflow
description: Feature workflow protocol for Architect. Covers issue/discussion/task lifecycle, MCP state capture, and SWE coordination.
---

# Architect Workflow

Workflow artifacts live in MCP (SQLite) and `docs/trustmybot/` at the project root.

## File Format Rules

| Artifact | Format | Audience | Rationale |
|---|---|---|---|
| `tasks.spec_body` (SQLite row) | Markdown H2 sections stored as a string | Architect → SWE | Structured contract in DB; retrieved via `task_get(task_id)` |

---

## Workflow Steps

### 0. Triage Double-Check

Bro passes a `triage:` field in the spawn prompt (`simple` or
`difficult`). Before any other workflow step, re-evaluate the classification
using the heuristic:

> **Does this request require updates to `docs/trustmybot/architecture/`?**
> If yes → `difficult`. If no → `simple`.

Bro's classification is a proposal; architect's is binding. Record the
final classification (even when confirming bro's):

```
discussion_append(
  kind='note',
  body='Triage: <simple|difficult> (bro proposed <x>, architect <confirmed|overrode>)'
)
```

### 1–8. Main Sequence

1. Create or resume MCP issue (`issue_create` or `issue_resume`) to anchor the work item.
2. Discuss via `discussion_append` until aligned with the Human — append `kind='question'` entries, read replies, iterate.
3. **Difficult path only:** capture the architectural plan before writing any specs:
   ```
   discussion_append(
     kind='decision',
     body=<architectural plan: what changes, why, trade-offs, risks>
   )
   ```
4. Author the spec body markdown (`spec_body`) using the template size
   matched to the triage result (see "Template Selection" below). Required H2
   sections: Description, Files, Success Criteria, Verification, Out of Scope,
   Commit.
5. Call `task_create_batch` passing `spec_body` to insert rows in SQLite.
   The row columns (`issue_id`, `branch_id`, `title`, `status`, `created_at`)
   hold the structured fields; the body is the free-form contract SWE reads.
6. Spawn SWE per task (one worktree per task) using `task_id=<N>` in the
   Task-tool prompt.
7. Validate per `skills/validate-swe-output/SKILL.md`.
8. Spawn PR Reviewer before reporting phase complete.
9. Close tasks via `task_update_status(status='closed')` once review passes.

**Loops until all tasks are closed.** After step 8, check for remaining open
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
4. Wait for Human replies; load them via `discussion_list(issue_id=<id>)` or
   from the conversation thread.
5. When aligned: **ALIGNED — PRODUCING TASK SPECS**

**Never skip discussion.** Explore code BEFORE asking questions.

---

## Template Selection

Both templates produce the same required H2 sections inside `spec_body`.
Choose based on triage result — the template size sets the depth of content
within those sections.

**simple triage → trivial template**
- Description: ≤ 3 sentences.
- Files: list affected paths.
- Success Criteria: 2–5 bullets; no validation matrix required.
- Verification: minimal commands sufficient to confirm the change.
- Commit: one-line message.
- Out of Scope and Results: may be empty placeholders.

**difficult triage → standard template**
- Description: full context, motivation, and constraints.
- Files: list with per-file description of what changes.
- Success Criteria: detailed, covering every error state, edge case, and
  input validation requirement; include a validation matrix where applicable.
- Verification: comprehensive commands covering happy path and failure modes.
- Out of Scope: explicit list of excluded concerns.
- Commit: one-line message.
- Results: empty placeholder (SWE fills on completion).

SWE must never guess. The required H2 headings are identical for both sizes;
only the content depth differs.

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
