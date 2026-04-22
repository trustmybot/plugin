# TMB Task Spec Format

Phase 2+ task specs live at:

  docs/trustmybot/tasks/<branch_id_filename>.md

where `<branch_id_filename>` is the git branch name with `/` replaced
by `-`. Examples:

| branch_id          | filename                                    |
|--------------------|---------------------------------------------|
| feat/user-login    | docs/trustmybot/tasks/feat-user-login.md    |
| fix/auth-crash     | docs/trustmybot/tasks/fix-auth-crash.md     |
| refactor/db-schema | docs/trustmybot/tasks/refactor-db-schema.md |

`/` is invalid in POSIX filenames; `-` is the only universally-safe
replacement and visually preserves the type/slug split.

## Frontmatter (YAML, required)

Every spec MUST start with a YAML frontmatter block:

```yaml
---
issue_id: <integer from MCP issue_create>
branch_id: <type>/<slug>            # e.g. feat/user-login
title: Short descriptive title
status: pending                       # pending | open | running | completed | failed
authorized_by: architect              # the agent that wrote this spec
authorized_at: 2026-04-21T15:00:00Z   # ISO-8601 UTC
depends_on: []                        # list of branch_ids this depends on
---
```

Field semantics:

- `status`: starts as `pending` when architect writes the spec.
  Allowed values match the existing MCP `tasks.status` enum
  (pending | running | needs_validation | completed | failed | escalated).
  `open` is accepted as a synonym for `pending` to keep parity with the
  legacy XML hook regex.
- `authorized_by`: the require-task-spec.sh hook checks for this key.
  Without it, SWE spawn is blocked.
- `depends_on`: branch_ids (NOT filenames) of tasks that must complete
  before this one is actionable.

## Body (markdown, free-form within sections)

The body uses markdown headings as section anchors. Required sections,
in order:

## Description

Prose explaining what the task does and why. Cite file paths with
line references. Quote actual code where it pins down behaviour.

## Files

A bullet list, one per file the SWE will create / modify / rename /
delete. Each line: `- path/to/file — action: brief note`.

## Success Criteria

Bullet list of testable assertions. Each must be true after SWE finishes.

## Verification

Fenced bash block (or several) listing the exact commands SWE runs to
confirm Success Criteria. Output must be inspectable.

## Out of Scope

Bullet list of nearby work that this task explicitly does NOT do.

## Commit

Fenced block containing the exact commit message SWE uses, including
the emoji prefix (Conventional Commits style per project CLAUDE.md).

## Results

Initially empty. After SWE finishes, SWE does NOT edit this section
(state lives in SQLite). PR Reviewer may regenerate a snapshot via
`issue_snapshot_md` for human review handoff.

---

## Template intensity (trivial vs standard)

The same headings above apply to both intensity levels. Intensity
controls how fully each section is populated, not the schema itself.

- `trivial`: used for simple-path tasks (see `tmb_workflow_two_paths.md`
  heuristic). Description ≤ 3 sentences. Success Criteria 2–5 bullets.
  Out of Scope and Results may be left empty.
- `standard`: used for difficult-path tasks. Every section must be
  populated. Success Criteria must cover error states, edge cases, and
  a validation matrix.

`trivial` is a SUBSET of `standard` — not a different schema. A trivial
spec is always valid as a standard spec with some sections omitted.

---

## State model (SQLite, not file)

The file is the SWE-readable spec. The DB is the canonical state.

| Action                         | Where it happens                                          |
|--------------------------------|-----------------------------------------------------------|
| Create spec                    | architect writes file + calls task_create_batch + task_set_spec_path |
| Begin execution                | swe calls task_update_status(running)                     |
| Finish execution               | swe calls task_update_status(completed) atomically with the commit |
| Validation pass / fail         | pr-reviewer calls validation_record(verdict=pass\|fail)  |
| Final close                    | architect calls task_update_status(closed) once review passes |

The file's `status:` frontmatter is informational only after the spec
is written; SQLite is authoritative. Hooks read SQLite (see
`scripts/hooks/lib/query-task.sh`).

## Hook compatibility

`scripts/hooks/require-task-spec.sh` continues to accept this format:
looks for `^authorized_by:` in frontmatter and `^status:\s*(pending|open)`
to gate SWE spawn. Phase 2 does not change this; the SQLite-driven
enforcement lives in `require-review-sign.sh`.
