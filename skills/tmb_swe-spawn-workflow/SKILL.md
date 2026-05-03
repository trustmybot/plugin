---
name: tmb_swe-spawn-workflow
description: Protocol for spawning SWE agents, worktree isolation, task spec template, parallel execution. Loaded on-demand by the planner (bro) right before SWE handoff.
---

# SWE Spawn Workflow

Rules for the planner (bro by default) when spawning SWE agents. PR Reviewer also follows the closing rules below.

## Worktree Isolation

Each SWE runs in an isolated git worktree at workspace-rooted path `<workspace_root>/.claude/worktrees/<slug>` so concurrent tasks don't collide and `.claude/` state stays out of the inner git repos.

**Bro pre-creates the worktree** (parallels the existing branch pre-creation). The flow:

1. **Commit all prerequisite changes first.** Worktrees branch from the latest commit, not uncommitted changes.
2. **Fetch remote pr_target so the new branch is born up-to-date.** Read `pr_target` from `config_get` (default `main`). Run `git -C <repo> fetch origin <pr_target> --quiet`. Do NOT advance your local `<pr_target>` — that happens only after MR merge (see push-gate's Post-merge cleanup).
3. **Bro creates the feature branch AND switches the main checkout to it.** From the main checkout: `git switch -c <task.branch_id> origin/<pr_target>`. The branch name MUST match `tasks.branch_id` exactly.
4. **Bro pre-creates the worktree** at the workspace-rooted path:
   ```bash
   # Compute workspace_root: dirname × 3 from the trajectory DB path.
   #   $TRAJECTORY_DB_PATH = <ws>/.claude/<plugin>/trajectory.db
   #   workspace_root      = <ws>
   WORKSPACE_ROOT="$(dirname "$(dirname "$(dirname "$TRAJECTORY_DB_PATH")")")"
   SLUG="${task.branch_id#*/}"   # strip the type/ prefix (fix/110-foo → 110-foo)
   WORKTREE="$WORKSPACE_ROOT/.claude/worktrees/$SLUG"
   git -C <repo> worktree add --detach "$WORKTREE" "<task.branch_id>"
   ```
   The `--detach` flag keeps the branch ref free for the main checkout. `<repo>` is the relative path from `tasks.repo` (defaults to the project root for single-repo CC).
5. **Spawn SWE with `worktree=<WORKTREE>`** in the prompt context, alongside `task_id=<N>`. SWE's first response is `cd <worktree>` + `task_get` in parallel.
6. **Verify after spawn.** Run `git worktree list` and confirm the worktree commit matches the branch HEAD. If it doesn't, halt the SWE and respawn.
7. If parallel SWEs touch the same file, run them sequentially.
8. **Override base when explicit.** If the task spec's `parent_branch_id` names a non-`pr_target` base (feature stack), use that base instead of `origin/<pr_target>`. Bro must still fetch + verify the alternative base.

**For single-repo CC users:** workspace_root == git_root, so the worktree lands at `<git_root>/.claude/worktrees/<slug>` — same as the previous behavior, zero migration needed.

**For workspace pattern** (TMB shape, fullstack `root/{api,app}`, etc.): workspace_root is the launch dir, distinct from each inner git repo. Worktrees land outside any inner repo, keeping inner repos clean.

## Post-SWE: bro merges + pushes

After SWE atomic-closes (commit + `task_update_status(needs_validation)`), bro runs the merge-then-push protocol:

1. **Merge SWE's commits into the local feature branch.** Bro is on the main checkout, on `<feature>`. Run from the main checkout:
   ```bash
   git fetch <worktree_path> HEAD:<feature>
   ```
   Where `<worktree_path>` is the absolute path bro pre-created (`<workspace_root>/.claude/worktrees/<slug>`). This fast-forwards the local `<feature>` ref to SWE's detached-HEAD commit.

2. **Push the local feature branch to origin.**
   ```bash
   git push origin <feature>
   ```
   Standard developer push. No detached-HEAD tricks. Origin mirrors local.

3. **Open the MR via `glab`** (or your platform CLI) with `--target-branch <base>`.

4. **Run the push gate** (`tmb_push-gate` skill) to spawn pr-reviewer for any unsigned tasks in the push.

5. **On all-pass**, merge the MR, switch the main checkout back to `<base>`, `git pull --ff-only`, then `task_update_status(closed)` for each task in the MR.

6. **Cleanup**: `git worktree remove <worktree_path>` (absolute path; the on-task-close hook also handles this automatically when bro flips the task to `closed`).

**Why bro merges from worktree** instead of letting SWE push: the local `<feature>` branch is the source of truth at every step. SWE's commits flow INTO the local branch via merge, then the local branch flows OUT to origin via push. SWE never pushes straight to origin — that would bypass your local-canonical invariant and your review. See `docs/architecture/GIT.md` for the full actor × stage table.

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
`bro_verification_pass` audit event, then calling `task_update_status(closed)`.

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
- Each SWE works in its bro-pre-created worktree at `<workspace_root>/.claude/worktrees/<slug>`
- **Do NOT parallelize when:** tasks share files, migrations pending, output
  dependencies exist
