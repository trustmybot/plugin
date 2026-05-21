# 06-post-close-cleanup

**Scenario under test:** the Human asks bro a question that requires reading a file for context. The file is registered in `file_registry` but its `summary` column is NULL. After bro Reads the file, bro must call `file_registry_update_summaries` to populate the summary so future sessions don't have to re-read.

Now passing after the MCP path-resolution fix (`resolveDefaultRepoPath` now reads `repos.path` first instead of synthesizing a workspace-pattern path). Pre-fix bro called the tool correctly but the MCP rejected with "file not found on disk." Post-fix bro's summary lands.

## What this captures

`CLAUDE.md` "Before answering — verify context" table:

> | After Read for context | follow with `file_registry_update_summaries` if `summary` was null |

The bug class this catches: bro reading a file for context but skipping the registry-summary update — leaving the registry stale across sessions, forcing re-Reads, and slowly burning context.

## Pre-state

`onboarding-named` fixture + a small Python file at `src/cli.py` (committed) and a pre-seeded `file_registry` row with `path='src/cli.py'`, `summary=NULL`, and the file's actual `content_md5`.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro what does src/cli.py do? Just summarize it for me.\n\nDon't ask questions.` |
| → | bro | calls `Read("src/cli.py")`, then `file_registry_update_summaries` to populate the summary; emits a concise summary in text |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `file_registry` row at `src/cli.py` has `summary IS NOT NULL` after the run |
| `outcome-coherence.json` | `file_registry WHERE path = 'src/cli.py' AND summary IS NOT NULL`: `=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `Read`; `file_registry_update_summaries` |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` (this is a context query, not a code change) |
| `cost-budget.json` | Soft 200K / 600s |
