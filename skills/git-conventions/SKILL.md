---
description: Commit message style, branching rules, push safety.
agent: swe, architect, pr-reviewer
---

# Git Conventions

## Commit Message Style

Two mandatory review gates. No exceptions.

### Gate 1 — Pre-Commit Review

- **When:** Before creating any commit
- **Who:** Architect spawns pr-reviewer agent
- **Mode:** pre-commit (focused on staged diff)
- **Gate:** BLOCK → fix; PASS → commit

### Gate 2 — Pre-Push Review

- **When:** Before `git push` or PR creation
- **Who:** Architect spawns pr-reviewer agent
- **Mode:** pre-push (comprehensive audit)
- **Gate:** BLOCK → fix; PASS WITH NOTES → human decides; PASS → push

### Gate 3 — Pre-Merge

- **When:** After `gh pr create`, before `gh pr merge`
- **Who:** Founder (explicit merge command required)
- **Mode:** human review of the actual diff on GitHub
- **Gate:** Never chain `gh pr merge` after `gh pr create`. Stop, hand PR URL + summary back to Founder, wait for explicit merge instruction.

Why: surfaced 2026-04-16 on PR #47 where pr-reviewer rationalized a missing fix as intentional; auto-merge denied the Founder the last-mile diff eyeball that would have caught it.

### Rules

- Never skip Gate 1 (even for "obvious" one-liners)
- Never skip Gate 2 (even if Gate 1 passed)
- SWE never commits directly (works in worktrees)
- Human can override with explicit "skip review" or "just commit"
- Never auto-merge. Gate 3 applies to every PR with no exceptions.

### Source Code Authorship Check

The PR Reviewer MUST verify at Gate 1:

- **Every source code change** (`src/`, `tests/`, `config/settings.toml`, `*.sql`) was made by a SWE agent, not the Architect or any other agent
- Check: the commit should reference a task file (`docs/trustmybot/tasks/*.xml`) or be attributed to a SWE worktree
- If the Architect directly edited source code: **BLOCK** with finding "architect_direct_edit_violation"
- This is a CRITICAL finding — the Architect must revert and re-do via SWE

## Branching Rules

- **`main`** — stable, production-ready. Only receives merges from `dev` via PR.
- **`dev`** — integration branch. All feature PRs target `dev`, never `main`.
- **Feature branches** — `feat/<name>`, branched from `dev`. One feature per branch.

### Rules

1. **Never commit directly to `dev` or `main`.** Always use feature branches + PRs.
2. **PRs always target `dev`** — `gh pr create --base dev --head feat/<name>`.
3. **Periodically merge `dev` → `main`** via a separate PR when `dev` is stable.
4. **Delete feature branches** after PR merge.

### Branch Creation

Always `git fetch origin dev` before creating a new feature branch. Stale `origin/dev` means the new branch misses merged PRs.

### Upstream Sources

When pulling code from upstream repos (e.g., shadcn-admin), use `git clone` into `$TMPDIR` and copy files. Never use `curl`/`fetch` on individual `raw.githubusercontent.com` URLs.

## Push Safety

### File Copy

When copying files from worktrees to the main repo, use `/bin/cp` (not `cp`) to bypass the macOS `cp -i` alias that prompts for overwrite confirmation.
