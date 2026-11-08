---
description: Start the local read-only dashboard (issues, tasks, agent runs, gates, audit, project map) and print its URL
argument-hint: (none)
---

# /dashboard

Start the dashboard server with the Bash tool, `run_in_background: true` and `dangerouslyDisableSandbox: true`, since the server only listens on 127.0.0.1 and the sandbox blocks local binding:

```
node "${CLAUDE_PLUGIN_ROOT}/dashboard/dist/server.mjs"
```

Read its output once it prints a line starting with `http://127.0.0.1:` and tell the Human to open that URL. The server keeps running in the background until the session ends or the Human stops it.

If it exits instead, report its error. If node reports the module missing, tell the Human `dashboard is not built: run (cd dashboard && bun install && bun run build)`. `EADDRINUSE` means a dashboard is already running on that port (default `http://127.0.0.1:7477/`); `TMB_DASHBOARD_PORT=0` picks a free port. `listen EPERM` means the sandbox blocked the bind, not a dashboard error; to keep the server sandboxed, the Human sets `sandbox.network.allowLocalBinding: true`.
