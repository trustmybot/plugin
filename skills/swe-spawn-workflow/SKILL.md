---
name: swe-spawn-workflow
description: Protocol for spawning SWE agents, worktree isolation, task files, and parallel execution.
---

# SWE Spawn Workflow

Rules for anyone who spawns SWE agents — typically the Architect.

## Worktree Isolation

Each SWE runs in an isolated git worktree so concurrent tasks don't collide.
If available, use the WorktreeCreate hook to fix CC's default `origin/HEAD`
branching behavior (branch from HEAD instead).

**Pre-spawn checklist:**
1. **Commit all prerequisite changes first.** Worktrees branch from the latest
   commit, not uncommitted changes.
2. **Verify after spawn.** Run `git worktree list` and confirm the worktree
   commit matches HEAD. If it doesn't, kill the SWE and respawn.
3. If parallel SWEs touch the same file, run them sequentially.
4. **NEVER copy a worktree's file to the main repo without `git diff` first.**
5. After copying worktree output, verify with lint + tests before committing.

## Task Spec Template (Markdown)

Each task spec is SWE's **sole source of truth**. Canonical format:
`docs/trustmybot/SPEC-FORMAT.md`.

**Naming:** `docs/trustmybot/tasks/<branch_id_filename>.md` where
`<branch_id_filename>` is the branch `type/slug` with `/` replaced by `-`
(e.g. `feat/user-login` → `feat-user-login.md`).

**Size limit: 200 lines maximum.** If a task exceeds 200 lines, split it into
multiple specs with `depends_on` chains. Each spec should cover 3-8 file edits
maximum. Do NOT create a spec that references another spec for its full content —
the spec must be self-contained.

**If SWE has to make a judgment call, the spec is underspecified.**

```markdown
---
issue_id: <integer from MCP issue_create>
branch_id: <type>/<slug>
title: Short descriptive title
status: pending
authorized_by: architect
authorized_at: <ISO-8601 UTC>
depends_on: []
---

## Description

Prose explaining what the task does and why. Cite file paths with line
references. Quote actual code where it pins down behaviour.

## Files

- path/to/file — action: brief note

## Success Criteria

- Bullet list of testable assertions.

## Verification

```bash
# Exact commands SWE runs to confirm Success Criteria.
```

## Out of Scope

- Nearby work this task explicitly does NOT do.

## Commit

```
emoji type(scope): message
```
```

One spec per file. Self-contained. Verifiable.

## Task Lifecycle

```
pending → running → completed → closed
               ↘ failed → (reopen as new task or abandon)
```

| Status | Set By | How |
|--------|--------|-----|
| `pending` | Architect | Spec written; `task_create_batch` + `task_set_spec_path` called |
| `running` | SWE | `task_update_status(running)` at start |
| `completed` | SWE | `task_update_status(completed)` atomic with commit |
| `closed` | PR Reviewer ONLY | `task_update_status(closed)` after `validation_record(verdict=pass)` |
| `failed` | SWE | `task_update_status(failed)` — escalate to Architect |

**SWE MUST call `task_get` to confirm `status='pending'` or `'open'` before
starting.** If status is anything else, STOP with:
```
REJECTED: Task status is "[status]", not pending/open. Only pending tasks can be executed.
```

**PR Reviewer closes tasks** via `task_update_status(closed)` after a passing
`validation_record`. This is the final audit stamp in SQLite — not a file edit.

## Parallel Execution

When tasks have no dependencies, spawn SWE agents concurrently in a single
message.

- Annotate: `depends_on: []` or `depends_on: [feat/other-task]` in the spec frontmatter
- Each SWE runs in `isolation: worktree`
- **Do NOT parallelize when:** tasks share files, migrations pending, output
  dependencies exist
