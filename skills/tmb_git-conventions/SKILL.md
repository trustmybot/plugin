---
name: tmb_git-conventions
description: Commit message style, branching rules, push safety.
agent: bro, swe, pr-reviewer
---

# Git Conventions

## Commit Message Style

Use Conventional Commits with an emoji prefix. Emoji per [gitmoji.dev](https://gitmoji.dev/) — the de facto standard:

```
✨ feat(api): add /users endpoint
🐛 fix(auth): handle expired refresh tokens
📝 docs(readme): clarify install steps
♻️ refactor(parser): extract URL canonicalizer
✅ test(orders): cover refund path
⚡ perf(query): batch N+1 lookups
🔧 chore(ci): bump node version
📦 build(deps): bump bun to 1.3
👷 ci(workflow): add Node 22 matrix
💄 style(button): align padding
⏪ revert(api): roll back /users endpoint
```

**Don't invent emoji.** If the type isn't covered above, look it up on gitmoji.dev — that's the authoritative source.

## Two review gates

| Gate | When | Who | What |
|---|---|---|---|
| **1. Bro task gate** | Immediately after SWE returns | Bro (planner) | Verifies SWE matched the spec — re-runs `## Verification`, sanity-checks diff against `## Files`, confirms each `## Success Criteria` bullet is met. Auto-runs per the `tmb_planning-simple` / `tmb_planning-difficult` "Bro verification protocol" section. |
| **2. PR-reviewer push gate** | When the Human runs `git push` to a protected branch | PR-reviewer (spawned by bro at push time) | Deeper mechanical + style + security pass over the batch of unsigned commits. Records `validation_record(verdict='pass'\|'fail')`. The `git-push-guard.sh` hook blocks the push until each task in the push range has a passing verdict. |
| **3. Human merge gate** | After `gh pr create`, before `gh pr merge` | Human (last-mile eyeball) | The pr-reviewer can miss things; the Human reviewing the diff on GitHub is the final check. Never chain `gh pr merge` after `gh pr create` — hand the PR URL back to the Human and wait for the explicit merge command. |

### Rules

- **SWE never commits to the main worktree** — only inside its own `.claude/worktrees/<task-slug>` worktree, which bro+pr-reviewer copy or merge into the main branch later.
- **Bro never edits source code directly.** Every code change goes through SWE.
- **Never auto-merge.** Gate 3 applies to every PR with no exceptions.
- **Never push to a protected branch** without the push gate passing. The hook makes it physically hard; respect the message.

### Source-code authorship check (PR-reviewer Gate 2)

PR-reviewer verifies at push time:

- Every source code change (`src/`, `tests/`, `config/settings.toml`, `*.sql`) corresponds to a `tasks` row whose `commit_sha` matches one of the commits being pushed.
- If a source-code commit has no matching task row, surface as a finding `untracked_source_change`. Either the change was made outside TMB (acceptable, but flag) or someone bypassed the planner (not acceptable — bro must never edit source directly).

## Branching Rules

- **`main`** — stable, production-ready. Receives merges from `dev` via PR.
- **`dev`** — integration branch. Feature PRs target `dev`, never `main`.
- **Feature branches** — `feat/<name>`, `fix/<name>`, etc., branched from `dev`. One feature per branch.

### Rules

1. **Never commit directly to `dev` or `main`.** Always use feature branches + PRs. Enforced by `scripts/hooks/git-guards.sh`.
2. **PRs target `dev`** — `gh pr create --base dev --head feat/<name>`.
3. **Periodically merge `dev` → `main`** via a separate PR when `dev` is stable.
4. **Delete feature branches** after PR merge.

### Branch creation

Always `git fetch origin dev` before creating a new feature branch. Stale `origin/dev` means the new branch misses merged PRs. Enforced by `git-guards.sh`.

### Upstream sources

When pulling code from upstream repos (e.g. shadcn-admin), use `git clone` into `$TMPDIR` and copy files. Never use `curl`/`fetch` on individual `raw.githubusercontent.com` URLs.

## Push safety

### File copy

When copying files from worktrees to the main repo, use `/bin/cp` (not `cp`) to bypass the macOS `cp -i` alias that prompts for overwrite confirmation.
