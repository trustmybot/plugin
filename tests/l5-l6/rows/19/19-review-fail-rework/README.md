# 19-review-fail-rework

**Scenario under test:** code-reviewer failed a closed task. The Human asks bro to fix what the reviewer found and send it back for review. Bro must reopen the existing task with `task_reopen` (GH 1197) — not plan a new task or retry under a new branch — so swe reworks it in the same worktree, then route it to code-reviewer for a second verdict.

## Pre-state

`onboarding-named` fixture. `setup-l5.sh` seeds:

- `main`: `src/cli.py` (todo CLI, `add` + `list`) and a 3-item `todos.json`.
- Branch `feat/add-count-subcommand` checked out in the linked worktree `.claude/worktrees/add-count-subcommand`, holding the first attempt: `count` prints `len(STORE.read_text())` (the file's character count) and crashes on a missing store.
- The `repos` row for the project (`INSERT OR IGNORE`, target `main`, `github-flow`).
- An open issue `Add count subcommand to todo CLI` and its task on `feat/add-count-subcommand`, `status='closed'`, `commit_sha` = the attempt, typed `files[]` / `verification[]`.
- A completed swe `agent_runs` row whose `root_dir` is the worktree path.
- `validation_attempts(attempt_n=1, agent='code-reviewer', verdict='fail')` with the reviewer's findings.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro the reviewer failed the count task — fix what it found and send it back for review.\n\nDon't ask questions.` |
| → | bro | reads the FAIL verdict, calls `task_reopen` on the count task (closed → running, worktree reused), spawns swe on it, then spawns code-reviewer on the new commit. Single turn. |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | a `task_reopened` audit row from `closed` on the count branch; exactly one task on that branch; ≥2 swe `agent_runs` on the task, all with one `root_dir`; ≥2 `validation_attempts` on the task |
| `outcome-coherence.json` | one task on the branch; `task_reopened >= 1`; `validation_attempts >= 2` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `task_reopen`, `Agent` |
| `tools-forbidden.json` | `issue_create`, `task_create_batch`, `task_provision`, `task_retry`, `AskUserQuestion` |
| `cost-budget.json` | Soft 300K / 900s (swe + code-reviewer) |

## Gaps (proxies)

- **Same worktree path reused.** Not scored. `task_reopen` reports `worktree_recreated` only in its tool result, which the scorers do not read. Once the second review passes, `cleanup-worktree-on-task-close.sh` removes the worktree, so the end state cannot tell reuse from recreation at the same path. Neither can the `root_dir` check in `outcome.sql`: `record-swe-spawn.sh` derives `root_dir` from `repos.path` plus the branch slug, so it is the same path either way; it stays only as a consistency check. The row scores the reopen itself instead: the `task_reopened` audit row, one task on the branch, and the second validation row.
- **Second validation row.** It lands only if code-reviewer runs inside the turn; a turn that ends after swe returns fails this check even when the rework is correct.
