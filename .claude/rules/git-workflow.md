---
paths:
  - ".git/**"
---

# Git Workflow

## Branch Strategy

- **`main`** — stable, production-ready. Only receives merges from `dev` via PR.
- **`dev`** — integration branch. All feature PRs target `dev`, never `main`.
- **Feature branches** — `feat/<name>`, branched from `dev`. One feature per branch.

## Rules

1. **Never commit directly to `dev` or `main`.** Always use feature branches + PRs.
2. **PRs always target `dev`** — `gh pr create --base dev --head feat/<name>`.
3. **Periodically merge `dev` → `main`** via a separate PR when `dev` is stable.
4. **Delete feature branches** after PR merge.

## Branch Creation

Always `git fetch origin dev` before creating a new feature branch. Stale `origin/dev` means the new branch misses merged PRs.

## Upstream Sources

When pulling code from upstream repos (e.g., shadcn-admin), use `git clone` into `$TMPDIR` and copy files. Never use `curl`/`fetch` on individual `raw.githubusercontent.com` URLs.

## File Copy

When copying files from worktrees to the main repo, use `/bin/cp` (not `cp`) to bypass the macOS `cp -i` alias that prompts for overwrite confirmation.
