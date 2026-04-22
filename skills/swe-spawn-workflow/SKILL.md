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

## Task File Template (XML)

Each task file is SWE's **sole source of truth**.

**Naming:** `docs/trustmybot/tasks/<YYYYMMDD-HHMM>_<descriptive_name>.xml` (timestamp + name)

**Size limit: 200 lines maximum.** If a task exceeds 200 lines, split it into
multiple task files. A 700-line task file exhausts SWE's context before
implementation begins. Each task file should cover 3-8 file edits maximum. Do
NOT create a task file that references another task file for its full spec —
the task must be self-contained.

**If SWE has to make a judgment call, the task is underspecified.**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<task phase="N" step="M" status="open">
  <authorized-by agent="architect" context="BLUEPRINT phase N" />
  <title>Short descriptive title</title>
  <depends>none | phase_N_step_M</depends>

  <context>
    File paths with line refs, existing patterns to follow.
    Cite actual code. Include verification commands.
  </context>

  <scope>
    Exact file paths, function signatures, input/output types, error responses.
  </scope>

  <error-handling>
    <case trigger="X" response="Y" />
  </error-handling>

  <edge-cases>
    <case input="X" behavior="Y" />
  </edge-cases>

  <verification>
    Exact commands to run. Example:
    npm test
    npm run lint
  </verification>

  <constraints>
    What NOT to do. Pattern references with file:line citations.
  </constraints>

  <commit>
    Commit message to use.
  </commit>

  <rollback>
    How to undo if validation fails.
  </rollback>
</task>
```

One task per file. Self-contained. Verifiable.

## Task Lifecycle

```
open → in_progress → completed → closed
                  ↘ failed → (reopen as new task or abandon)
```

| Status | Set By | Meaning |
|--------|--------|---------|
| `open` | Architect | Task created, ready for SWE |
| `in_progress` | SWE | SWE is executing |
| `completed` | SWE | SWE finished, results appended |
| `closed` | PR Reviewer ONLY | Reviewed and approved |
| `failed` | SWE | SWE could not complete |

**SWE MUST check `status="open"` before starting.** If status is anything else,
STOP with:
```
REJECTED: Task status is "[status]", not "open". Only open tasks can be executed.
```

**PR Reviewer closes tasks** by changing `status="completed"` to
`status="closed"` after successful review. This is the final audit stamp.

## Parallel Execution

When tasks have no dependencies, spawn SWE agents concurrently in a single
message.

- Annotate: `depends="none"` or `depends="phase_1_step_2"` in the task XML
- Each SWE runs in `isolation: worktree`
- **Do NOT parallelize when:** tasks share files, migrations pending, output
  dependencies exist
