---
paths:
  - ".git/**"
---

# Commit Protocol

Two mandatory review gates. No exceptions.

## Gate 1 — Pre-Commit Review

- **When:** Before creating any commit
- **Who:** Architect spawns pr-reviewer agent
- **Mode:** pre-commit (focused on staged diff)
- **Gate:** BLOCK → fix; PASS → commit

## Gate 2 — Pre-Push Review

- **When:** Before `git push` or PR creation
- **Who:** Architect spawns pr-reviewer agent
- **Mode:** pre-push (comprehensive audit)
- **Gate:** BLOCK → fix; PASS WITH NOTES → human decides; PASS → push

## Gate 3 — Pre-Merge

- **When:** After `gh pr create`, before `gh pr merge`
- **Who:** Founder (explicit merge command required)
- **Mode:** human review of the actual diff on GitHub
- **Gate:** Never chain `gh pr merge` after `gh pr create`. Stop, hand PR URL + summary back to Founder, wait for explicit merge instruction.

Why: surfaced 2026-04-16 on PR #47 where pr-reviewer rationalized a missing fix as intentional; auto-merge denied the Founder the last-mile diff eyeball that would have caught it.

## Rules

- Never skip Gate 1 (even for "obvious" one-liners)
- Never skip Gate 2 (even if Gate 1 passed)
- SWE never commits directly (works in worktrees)
- Human can override with explicit "skip review" or "just commit"
- Never auto-merge. Gate 3 applies to every PR with no exceptions.

## Source Code Authorship Check

The PR Reviewer MUST verify at Gate 1:

- **Every source code change** (`src/`, `tests/`, `config/settings.toml`, `*.sql`) was made by a SWE agent, not the Architect or any other agent
- Check: the commit should reference a task file (`bro/tasks/*.xml`) or be attributed to a SWE worktree
- If the Architect directly edited source code: **BLOCK** with finding "architect_direct_edit_violation"
- This is a CRITICAL finding — the Architect must revert and re-do via SWE
