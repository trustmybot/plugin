# dashboard

A local, read-only web view of the trajectory DB: issues, tasks, agent runs, gate results (review verdicts and verification runs) and the audit feed.

- `server/` — a `node:http` server bound to `127.0.0.1` that opens `trajectory.db` read-only through `node:sqlite` and answers a JSON API under `/api/`. Every query is a `SELECT` in `server/queries.ts`. The DB path comes from `resolveClaudeDbPath` in `mcp/trajectory-server/src/platform.ts`, the same rule the MCP server uses.
- `web/` — a React + Tailwind + TanStack Query/Table single-page app. It polls `/api/version` (`PRAGMA data_version`) every 2 s and refetches when the DB changes. Dark or light follows `prefers-color-scheme`.
- `dist/` — the committed build: `server.mjs` (one bundled file, no runtime dependencies) and `web/` (static assets the server serves).

## Run

```bash
scripts/dashboard.sh
```

Run it from an onboarded project (or set `CLAUDE_PROJECT_DIR`), or point it at a DB with `TRAJECTORY_DB_PATH=/path/to/trajectory.db`. It listens on port 7477; set `TMB_DASHBOARD_PORT` to change it (`0` picks a free port). It prints the URL to open. There is no auth, so it binds to loopback only.

## API

| Endpoint | Returns |
|---|---|
| `/api/summary` | open/closed issue counts, tasks by status, running agent count, the 10 most recent runs |
| `/api/issues` | every issue with its task progress |
| `/api/issues/:id` | the issue, its discussions and its tasks (404 when unknown) |
| `/api/tasks` | the most recent 1000 tasks |
| `/api/agent-runs` | the most recent 200 agent runs |
| `/api/gates` | the most recent 200 review verdicts and 200 verification runs |
| `/api/audit?limit=` | the latest audit rows (default 100, 1–1000) |
| `/api/version` | `{ data_version }` for polling |

## Build

Requires Node 22+ and Bun. The build type-checks, bundles the server with esbuild, bundles the app with esbuild and builds the CSS with Tailwind; every package is a devDependency.

```bash
cd dashboard
bun install --frozen-lockfile
bun run build
```

Commit `dist/` with the source change.

## Tests

- `bash dashboard/test/smoke.sh` — seeds a temp DB from `schema.sql`, starts the built server on a free port, checks the page and each endpoint, and checks the DB file is unchanged.
- `bash dashboard/test/size-budget.sh` — fails when the gzipped JS + CSS in `dist/web` is over 250 KB.
