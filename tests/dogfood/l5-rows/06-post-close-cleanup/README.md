# 06-post-close-cleanup

**Scenario under test:** the Human asks bro a question that requires reading a file for context. The file is registered in `file_registry` but its `summary` column is NULL. After bro Reads the file, bro must call `file_registry_update_summaries` to populate the summary so future sessions don't have to re-read.

> **Status: currently FAILING** (as of the L6 round-4 MR). This scenario documents a *captured bug class* — bro Read `src/auth.py`, gave a high-quality summary in chat, but skipped the `file_registry_update_summaries` call. The registry stays stale, future sessions re-Read, context gets burned. Daisy's "L6 capture more bugs" directive is satisfied by leaving this scenario as-failing; a follow-up should add a registry-update reminder to `tmb_recovery` or the post-Read hook.

## What this captures

`CLAUDE.md` "Before answering — verify context" table:

> | After Read for context | follow with `file_registry_update_summaries` if `summary` was null |

The bug class this catches: bro reading a file for context but skipping the registry-summary update — leaving the registry stale across sessions, forcing re-Reads, and slowly burning context.

## Pre-state

`onboarding-named` fixture + a small Python file at `src/auth.py` (committed) and a pre-seeded `file_registry` row with `path='src/auth.py'`, `summary=NULL`, and the file's actual `content_md5`.

## Turns

| # | Speaker | Message |
|---|---|---|
| 1 | user | `@bro what does src/auth.py do? Just summarize it.` |
| → | bro | calls `Read("src/auth.py")`, then `file_registry_update_summaries` to populate the summary |
| 2 | user | `Got it. Anything else?` |
| → | bro | terminal |

## Pass criteria

| Scorer | Asserts |
|---|---|
| `outcome.sql` | `file_registry` row at `src/auth.py` has `summary IS NOT NULL` after the run |
| `outcome-coherence.json` | `file_registry WHERE path = 'src/auth.py' AND summary IS NOT NULL`: `=1` |
| `outcome-git.json` | `base_branch_unchanged: true` |
| `tools-required.json` | `Read`; `file_registry_update_summaries` |
| `tools-forbidden.json` | `task_create_batch`, `issue_create`, `Agent` (this is a context query, not a code change) |
| `cost-budget.json` | Soft 200K / 600s |
