---
description: Start the local read-only dashboard (issues, tasks, agent runs, gates, audit, project map) and print its URL
argument-hint: (none)
---

# /dashboard

Start the dashboard server with the Bash tool, `run_in_background: true`:

```
bash "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.sh"
```

Read its output once it prints a line starting with `http://127.0.0.1:` and tell the Human to open that URL. The server keeps running in the background until the session ends or the Human stops it.

If it exits instead, report its error. `EADDRINUSE` means a dashboard is already running on that port (default `http://127.0.0.1:7477/`); `TMB_DASHBOARD_PORT=0` picks a free port.
