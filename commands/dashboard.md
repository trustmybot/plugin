---
description: Start the local dashboard (issues, tasks, agent runs, gates, audit, project map), which can also edit and close issues, add comments and change config, and print its URL
argument-hint: (none)
---

# /dashboard

Start the dashboard server with the Bash tool and `run_in_background: true`, inside the sandbox:

```
node "${CLAUDE_PLUGIN_ROOT}/dashboard/dist/server.mjs"
```

Read its output once it prints a line starting with `http://127.0.0.1:` and tell the Human to open that URL. The server keeps running in the background until the session ends or the Human stops it.

If it exits instead, report its error. `listen EPERM` means the sandbox blocked binding to loopback, not a dashboard error: re-run the same command once with `run_in_background: true` and `dangerouslyDisableSandbox: true`, and tell the Human that `/onboard`'s sandbox step sets `sandbox.network.allowLocalBinding` so the next start stays in the sandbox. If node reports the module missing, tell the Human `dashboard is not built: run (cd dashboard && bun install && bun run build)`. `EADDRINUSE` means a dashboard is already running on that port (default `http://127.0.0.1:7477/`); `TMB_DASHBOARD_PORT=0` picks a free port.
