---
description: Populate the world model — a kuzu graph of the project's directories — by walking the session dir for git repos and pulling each dir's README.md into a summary. Single phase — no background fill required for the primary navigation surface.
argument-hint: (none)
---

# /scan

One MCP call. The server walks the session dir, discovers git repos, and for each unique directory in each repo writes a kuzu `Directory` node — linked to its parent by a `CONTAINS` edge — carrying the file count + a summary pulled from `<dir>/README.md` (when present).

## Auto-fire trigger

Bro runs `/scan` before any `task_create_batch` call when the world model is empty AND the project has source files. If you skip it, `world_model_get` returns `warning: 'world-model-empty'` and bro can't plan.

`/scan` also runs after every `bro_atomic_close` (via `post-task-close-rescan.sh`) to refresh the world model against the new git state.

## What it does

```
scan_run(agent='bro', source='user_manual')
```

The server walks the session dir, discovers git repos, and for each unique directory writes a kuzu `Directory` node with a README-derived summary (falling back to a structural summary when no README exists). Returns `{session_dir, scanned_at, repos[], repos_upserted, dirs_upserted, dirs_readme_summarized}`.

## Scope

Allowed:
- `mcp__plugin_tmb_trajectory-server__scan_run`

Forbidden during `/scan`:
- `task_create_batch` (this is a maintenance op, not feature work)
- `issue_create` (same)
- `Bash` (server already forks scan.sh; bro doesn't need shell)

## Idempotency

Re-running `/scan` is summary-preserving: a directory with a README-derived summary refreshes from the (possibly-edited) README; a directory without a README is left alone (structural fields like `file_count` update; `summary` is not cleared).
