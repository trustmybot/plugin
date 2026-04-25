---
name: swe-spawn-workflow
description: Protocol for spawning SWE agents, worktree isolation, task spec template, parallel execution. Loaded on-demand by the planner (bro) right before SWE handoff.
---

# SWE Spawn Workflow

Rules for the planner (bro by default) when spawning SWE agents. PR Reviewer also follows the closing rules below.

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

## Task Spec Body Template (Markdown stored in `tasks.spec_body`)

Each task spec body is SWE's **sole source of truth**. SWE retrieves it via
`task_get(task_id)`.

**Size limit: 200 lines maximum.** If a task exceeds 200 lines, split it into
multiple tasks with `depends_on` chains. Each task should cover 3-8 file edits
maximum. Do NOT create a spec that references another spec for its full content —
the spec must be self-contained.

**If SWE has to make a judgment call, the spec is underspecified.**

Structured fields (issue_id, branch_id, title, status, created_at, parent_branch_id)
live as columns on the `tasks` row. The `spec_body` string holds only the body
sections — no frontmatter, no metadata:

```markdown
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

One spec per task row. Self-contained. Verifiable.

## Task Lifecycle

```
pending → running → completed → closed
               ↘ failed → (reopen as new task or abandon)
```

| Status | Set By | How |
|--------|--------|-----|
| `pending` | Planner (bro) | Row inserted with non-empty `spec_body` via `task_create_batch` |
| `running` | SWE | `task_update_status(running)` at start |
| `completed` | SWE | `task_update_status(completed)` atomic with commit |
| `closed` | bro | `task_update_status(closed)` after pr-reviewer's `validation_record(verdict=pass)` |
| `failed` | SWE | `task_update_status(failed)` — escalate to bro |

**SWE MUST call `task_get` to confirm `status='pending'` or `'open'` before
starting.** If status is anything else, STOP with:
```
REJECTED: Task status is "[status]", not pending/open. Only pending tasks can be executed.
```

**bro closes tasks** via `task_update_status(closed)` after pr-reviewer
records a passing `validation_record`. This is the final audit stamp in
SQLite — not a file edit. pr-reviewer signs the verdict; bro flips state.

## Parallel Execution

When tasks have no dependencies, spawn SWE agents concurrently in a single
message. Use `task_id=<N>` in each Task-tool prompt (decimal integer primary
key of the tasks row). Example: `swe, execute task_id=42 for issue 7`.

- Annotate: `depends_on: []` or `depends_on: [feat/other-task]` in the task row (`tasks.parent_branch_id`)
- Each SWE runs in `isolation: worktree`
- **Do NOT parallelize when:** tasks share files, migrations pending, output
  dependencies exist
