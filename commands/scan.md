---
description: Populate the world model — a kuzu graph of the project's directories — by walking the session dir for git repos and pulling each dir's README.md into a summary. Single phase — no background fill required for the primary navigation surface.
argument-hint: (none)
allowed-tools: mcp__plugin_tmb_trajectory-server__scan_run
---

# /scan

Use `/scan` for a manual refresh of the world model.

```
scan_run(agent='bro', source='user_manual')
```

## Idempotency

Re-running `/scan` is summary-preserving: a directory with a README-derived summary refreshes from the (possibly-edited) README; a directory without a README is left alone (structural fields like `file_count` update; `summary` is not cleared).
