# dashboard

A local web view of the trajectory DB: issues, tasks, agent runs, gate results (review verdicts and verification runs), the audit feed, a project map of the world model and its concepts. In the issue view the Human can edit an issue, add a comment and close it.

- `server/` — a `node:http` server bound to `127.0.0.1` that opens `trajectory.db` read-only through `node:sqlite` and answers a JSON API under `/api/`. Every read is a `SELECT` in `server/queries.ts`, or in `server/concepts.ts` and the trajectory server's concept functions it calls. Writes (`server/writes.ts`) call the trajectory server's own handlers in-process over a `TrajectoryDB` opened with its default options, which never migrate: an older DB is refused unchanged; the dashboard has no write SQL of its own. The DB path comes from `resolveClaudeDbPath` in `mcp/trajectory-server/src/platform.ts`, the same rule the MCP server uses.
- `web/` — a React + Tailwind + TanStack Query/Table single-page app. It polls `/api/version` (`PRAGMA data_version`) every 2 s and refetches when the DB changes. Dark or light follows `prefers-color-scheme`. The page is fluid up to 120rem. Table cells stay on one line: long prose columns are cut with the full text in `title`, and a wide table scrolls sideways. Timestamps render through `<Time>` (`web/Time.tsx`) as a `<time>` in a short `Intl.DateTimeFormat` form with the full date in `title`. Issue descriptions, discussion bodies and concept and step descriptions render GitHub-flavoured markdown through `<Markdown>` (`web/Markdown.tsx`, `react-markdown` + `remark-gfm`): raw HTML is skipped, never rendered, and the default URL filter drops `javascript:` links.
- `dist/` — the committed build: `server.mjs` (one bundled file, no runtime dependencies), `schema.sql` and `schema-eval.sql` (copied from the trajectory server; `TrajectoryDB` reads them beside its module when it opens the write connection, re-applying the current schema idempotently on a DB already at `TARGET_SCHEMA_VERSION`) and `web/` (static assets the server serves).

## Run

```bash
scripts/dashboard.sh
```

Or run `/tmb:dashboard` in a Claude Code session: it starts the same script in the background and reports the URL. Run it from an onboarded project (or set `CLAUDE_PROJECT_DIR`), or point it at a DB with `TRAJECTORY_DB_PATH=/path/to/trajectory.db`. It listens on port 7477; set `TMB_DASHBOARD_PORT` to change it (`0` picks a free port). It prints the URL to open. It binds to loopback only and answers only requests whose `Host` is `127.0.0.1:<port>` (anything else, `localhost` included, is 403), so a DNS-rebinding page cannot read it. Reads need no auth; writes need the per-launch token (see Writes).

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
| `/api/world-model?repo=&path=&depth=` | `{ available, repos, nodes }`: the directory at `path` (default the repo root) and its subdirectories `depth` levels down (default 2, 0–5), each with `repo`, `path`, `parent_path`, `summary`, `file_count`; `repo` defaults to the first repo |
| `/api/world-model/search?q=&limit=` | `{ available, hits }`: FTS5 hits over directory paths and summaries and file paths and purposes, best `bm25` rank first, each with `kind`, `repo`, `path`, `text`, `rank` (default 20, 1–100). `q` is matched as one phrase, so FTS syntax in it is plain text |

| `/api/concepts?q=&repo=&limit=` | `{ available, repos, repo, concepts, derived }`: saved concepts matching `q` (default 20, 1–50), each with `id`, `name`, `body`, `step_count` and `trust` counts. When none matches, `derived` is an unverified chain read off the call graph, else `null`. A `q` under 2 characters after trimming returns `concepts: []`, `derived: null`; `repo` defaults to the first repo by name |
| `/api/concepts/:id` | the concept with its ordered `steps` (at most 50; `steps_truncated` says when more exist). Each step has `ordinal`, `description`, `trust`, `trust_reason`, `handoff` and `symbol` (`null` when the anchor is gone, then `trust: broken`) |
| `/api/concepts/:id/graph?limit=` | `{ nodes, edges, truncated }`: the step symbols plus their 1-hop `calls`, `sources`, `runs` and `imports` neighbours over exact edges, test and fixture paths dropped (default 60, 1–120). Step nodes are never cut; neighbours fill the rest of the limit in step order. Each node has `id`, `label`, `repo`, `path`, `dir`, `kind`, `line_start` and `step_ordinal` (`null` for a neighbour); each edge `src`, `dst`, `kind` |
| `/api/symbols/:id/neighbourhood?limit=` | the same shape for one symbol and its 1-hop neighbours (default 40, 1–100), used to expand a graph node |

Both world-model endpoints pass each `summary` and `text` through `summaryLine` in `server/queries.ts`: the `<untrusted-content>` framing and markdown syntax are removed and the first non-empty line is returned, at most 160 characters.

Both world-model endpoints answer `available: false` with empty arrays (HTTP 200) when the DB has no `wm_*` tables yet (schema below v42).

The concept endpoints answer `available: false` (HTTP 200) on a DB below schema v45 or without the concept tables, and 404 JSON for an unknown id. They call the trajectory server's `searchConcepts`, `getConcept` and `derivedChain` in-process over the read-only connection, so they never write or migrate the DB.

`/api/issues/:id` also returns `label_taxonomy` (`classification` and `priority` lists from `plugin_config`) and `milestones` (names known for the issue's repo) for the edit form.

## Writes

`POST /api/issues/:id/<action>` with a JSON body (`content-type: application/json`):

| Action | Body | Handler |
|---|---|---|
| `edit` | `updated_at` plus any of `objective`, `description`, `labels` (array, one classification and one priority), `milestone` | `issue_update`, then `issue_update_description` for `description` |
| `comment` | `body` | `discussion_append` with `author: human`, `kind: note` |
| `close` | `updated_at` | `issue_close` (no cascade, no waiver) |

Guards, in order:

- `Host` must be `127.0.0.1:<port>` (as for every request) and `Origin` must be `http://127.0.0.1:<port>`; anything else (no `Origin` and `localhost` included) is 403.
- The `x-tmb-token` header must match the token generated at launch and injected into `index.html` as `<meta name="tmb-token">`; otherwise 403.
- Unknown actions or paths are 404, other methods 405, unknown body fields 400. A body over 2 MB is 413 `body_too_large`: the server stops buffering, sends the 413 with `Connection: close` and discards the rest of the upload, so the client receives the response.
- The DB's `plugin_meta.schema_version` must equal the bundled `TARGET_SCHEMA_VERSION`; otherwise 409 `schema_version_mismatch`. The dashboard never migrates the DB.
- `edit` and `close` must send the `updated_at` they rendered; a changed issue is 409 `stale` with the current `updated_at`. The check and the handler's local write run in one `BEGIN IMMEDIATE` on the write connection, so another process cannot change the issue in between; the lock is released before any remote sync. An edit that changes `description` together with other fields runs `issue_update` and `issue_update_description` as two such steps, the second checked against the `updated_at` the first wrote, so a change landing between them is 409 `stale` with `applied: ["issue_update"]`.

A handler refusal is 422 with the handler's `error`, `message` and data (for a refused close, the blocking `tasks`). Each successful handler call adds an `issue_updated` audit row from `dashboard` whose `content_json` carries `actor: human`, `source: dashboard`, `tool` and `fields`. The embedding model is not loaded in the dashboard (the build aliases `@huggingface/transformers` to `server/no-embeddings.ts`); the trajectory server's backfill embeds new rows on its next start.

The issue view has an Edit button (objective, description, priority, labels, milestone), a comment box under the discussion, and a Close button for open issues. Errors show the handler's message, any blocking tasks and, for a partly applied edit, the `applied` handlers.

The editor snapshots the issue when it opens. Its fields, the changed-field diff it sends and the `updated_at` it sends all come from that snapshot, never from the live refetch, so a change another session makes mid-edit is never sent back as if the Human had typed it: Save gets 409 `stale` instead. When the live `updated_at` moves past the snapshot, the editor shows a notice that the issue changed; cancel and reopen the editor to load it.

## Project map

The Project map tab reads the world model `/scan` builds: a repo selector, a directory tree that loads each directory's children when you expand it (with its README summary and file count), and a search box that lists matching directories and files with their paths. On a DB without the world-model tables it says so: open a Claude Code session to upgrade the DB, then run `/scan`.

## Concepts

The Concepts tab (`#/concepts?q=…`, `#/concepts/:id`) searches the concept layer: a concept is a feature traced step by step through the functions that make it up. Type at least 2 characters; the results list (arrow keys move, Enter selects) shows each concept's step count and trust counts. When no saved concept matches, an unverified chain built from the call graph is offered instead. The URL holds the search and the selection, so back, forward and a pasted link restore them; typing updates the URL without adding history entries.

Selecting a result shows the concept's trust (the worse of its stored status and its steps' trust, so one broken step makes it Broken) and its steps as a numbered list, each with its function, description, trust badge (Verified, Suspect or Broken) and `path:line`, and a graph beside it: one column per step, each step's neighbours in its column, grouped by directory. `calls` edges are solid, `imports` dashed, `runs` and `sources` dotted, and a plain "then" line joins derived steps with no recorded handoff. Selecting a step highlights its node and clicking a node selects its step; selecting a neighbour offers "Show neighbours" to expand it. "Show as table" lists the edges. Below 1024 px the columns stack and the graph sits behind "Show graph". On a DB without concepts the tab says to run `/scan`.

## Build

Requires Node 22+ and Bun. The server imports trajectory-server source, so run `bun install --frozen-lockfile` at the repo root too for its types. The build type-checks, bundles the server with esbuild, bundles the app with esbuild and builds the CSS with Tailwind; every package is a devDependency.

```bash
cd dashboard
bun install --frozen-lockfile
bun run build
```

Commit `dist/` with the source change.

## Tests

- `bash dashboard/test/smoke.sh` — seeds a temp DB from `schema.sql`, starts the built server on a free port, checks the page and each endpoint (world-model tree and search included, plus FTS syntax in a search query), and checks the DB file is unchanged; then checks both world-model endpoints answer `available: false` on a DB without the `wm_*` tables.
- `bash dashboard/test/writes.test.sh` — builds a temp DB with `TrajectoryDB` under `$TMPDIR` and a fake `HOME`, starts the built server on a free port and checks each edit, the Human comment, the refused and the allowed close, their audit rows, the stale, token, Origin, Host (on GET too), body-size (the client receives the 413), path and schema-version guards, that the dashboard's `TrajectoryDB` open refuses an older DB and leaves it unmigrated with no backup, and that `server/*.ts` has no write SQL.
- `node --test dashboard/test/concepts.test.mjs` — seeds a temp DB from `schema.sql` with a small symbol index and a 3-step concept whose last anchor is gone, starts the built server and checks concept search (a description word, a derived chain, a too-short query), the detail, the graph and its limit, a symbol neighbourhood, 404s, `available: false` on a v44 DB, and that both DB files are unchanged. `node dashboard/test/concepts.test.mjs --seed <path>` only writes the seeded DB, to view the tab against it.
- `node --test dashboard/test/ux.test.mjs` — seeds a temp DB with a directory summary and a file purpose wrapped in `<untrusted-content>` and written in markdown, starts the built server and checks `/api/world-model` and `/api/world-model/search` return each as one plain line; unit-tests `summaryLine`; and renders `<Markdown>` to static HTML to check GFM renders and `<script>`, `<img onerror>` and `javascript:` links never do.
- `bash dashboard/test/size-budget.sh` — fails when the gzipped JS + CSS in `dist/web` is over 250 KB.
