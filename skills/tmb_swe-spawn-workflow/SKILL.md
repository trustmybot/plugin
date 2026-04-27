---
name: tmb_swe-spawn-workflow
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
2. **Sync local with remote pr_target.** Read `pr_target` from `config_get` (default `main`). Run `git fetch origin <pr_target> --quiet` then `git merge --ff-only origin/<pr_target>` on your local `<pr_target>` branch (or `git pull --ff-only` if you're on it). Catches the "stale local main" bug where bro creates a task branch from yesterday's pointer; the `branch-up-to-date-with-remote.sh` PreToolUse hook will deny SWE's worktree-add if you skip this.
3. **Bro creates the branch BEFORE spawning SWE.** Run `git branch <task.branch_id> origin/<pr_target>` from your session (use `origin/<pr_target>` after the fetch above so the branch is born up-to-date). The branch name MUST match `tasks.branch_id` exactly. SWE then attaches the worktree with `git worktree add <path> <branch>` (no `-b`/`-B` — a PreToolUse hook rejects branch creation by SWE; #170). This makes branch authority structurally bro's, eliminating the SWE-renames-the-branch class of bug.
4. **Override base when explicit.** If the task spec's `parent_branch_id` names a non-`pr_target` base (feature stack), use that base instead of `origin/<pr_target>`. Bro must still fetch + verify the alternative base.
5. **Verify after spawn.** Run `git worktree list` and confirm the worktree
   commit matches HEAD. If it doesn't, kill the SWE and respawn.
6. If parallel SWEs touch the same file, run them sequentially.
7. **NEVER copy a worktree's file to the main repo without `git diff` first.**
8. After copying worktree output, verify with lint + tests before committing.

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
| `closed` | bro | `task_update_status(closed)` after bro's own task-gate verification (V1/V2/V3) — see planning skills |
| `failed` | SWE | `task_update_status(failed)` — escalate to bro |

**SWE MUST call `task_get` to confirm `status='pending'` or `'open'` before
starting.** If status is anything else, STOP with:
```
REJECTED: Task status is "[status]", not pending/open. Only pending tasks can be executed.
```

**bro closes tasks** by running its own task-gate verification (the V1/V2/V3
protocol in `tmb_planning-simple` and `tmb_planning-difficult`), writing a
`bro_verification_pass` ledger event, then calling `task_update_status(closed)`.

**pr-reviewer is NOT involved at task close.** PR-reviewer is the **push gate**
— it runs at `git push` time over the batch of unsigned commits, signs them
with `validation_record(verdict='pass')`, and unblocks the push. Per-task
sign-off is bro's job; per-push sign-off is pr-reviewer's. See the "Push gate"
section of plugin `CLAUDE.md`.

## Parallel Execution

When tasks have no dependencies, spawn SWE agents concurrently in a single
message. Use `task_id=<N>` in each Task-tool prompt (decimal integer primary
key of the tasks row). Example: `swe, execute task_id=42 for issue 7`.

- Annotate: `depends_on: []` or `depends_on: [feat/other-task]` in the task row (`tasks.parent_branch_id`)
- Each SWE runs in `isolation: worktree`
- **Do NOT parallelize when:** tasks share files, migrations pending, output
  dependencies exist
