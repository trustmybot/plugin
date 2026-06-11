---
description: Populate the world model — a kuzu graph of the project's directories — by walking the session dir for git repos and pulling each dir's README.md into a summary. Single phase — no background fill required for the primary navigation surface.
argument-hint: (none)
allowed-tools: mcp__plugin_tmb_trajectory-server__scan_run
---

# /scan

One MCP call. The server walks the session dir, discovers git repos, and for each unique directory in each repo writes a kuzu `Directory` node — linked to its parent by a `CONTAINS` edge — carrying the file count + a summary pulled from `<dir>/README.md` (when present).

## Auto-fire trigger

The world model stays warm through three layers: SessionStart auto-scans when the model is cold; `task_create_batch` refuses to run until the world model is warm; and `post-task-close-rescan.sh` refreshes it after every `bro_atomic_close`. Use `/scan` for a manual refresh outside those automatic paths.

## What it does

```
scan_run(agent='bro', source='user_manual')
```

When a directory has no README, the summary falls back to a structural one.

## Scope

`/scan` calls exactly one tool: `scan_run`. It's a maintenance op — task and issue creation stay out of it, and the server already forks `scan.sh`, so there's no shell work for bro.

## Idempotency

Re-running `/scan` is summary-preserving: a directory with a README-derived summary refreshes from the (possibly-edited) README; a directory without a README is left alone (structural fields like `file_count` update; `summary` is not cleared).
