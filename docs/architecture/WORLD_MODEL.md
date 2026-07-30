# World Model

Bro is the architect of every project it works on. The world model is the stable, queryable mental picture bro reasons from — built by `scan_run`, refreshed lazily, queried on every cold start.

## Substrate: kuzu graph database

The world model lives in a dedicated **kuzu** graph database at `<project>/.claude/tmb/world-model.kuzu/`, separate from the standard trajectory DB. A custom `TRAJECTORY_DB_PATH` uses `<db-basename>.world-model.kuzu` so separate SQLite files cannot share one graph. This is by design:

| | Graph DB (kuzu) | Trajectory DB (SQLite) |
|---|---|---|
| Content | Project mental model: dirs as nodes, parent/import/call relations as edges | Workflow audit: issues, tasks, discussions, validation, plugin metadata |
| Engine | kuzu (embedded, single file, MIT, Cypher) | SQLite via node:sqlite |
| Bro's use | "What does this project look like?" / "Where does X live?" / "What depends on what?" | "What did we decide?" / "What's open?" / "What did SWE commit?" |

**Why a graph DB.** Directory structure — and the import/call relations layered on top of it — is graph-shaped, so a graph engine turns refactor-blast-radius and dependency queries into single traversals instead of recursive SQL. kuzu also carries its own vector + full-text indexes, so semantic and keyword search travel with the graph rather than in a parallel SQLite store, and the trajectory DB stays purpose-pure as the workflow audit.

## Schema

Initial schema (v0.7 ship):

```
NODE Directory   { key (PK), repo, path, parent_path, summary, summary_source, summary_updated_at, file_count }
EDGE CONTAINS    (Directory) → (Directory)    // parent → child
```

`key` is the composite string `<repo>:<path>` — kuzu requires single-column primary keys.

Follow-up slices (post-v0.7) add `File`, `Symbol`, `IMPORTS`, `CALLS`, `DEFINES` nodes + edges for code-structure reasoning.

## Population

`scan_run` walks the session dir for git repos, derives the unique directory set from each repo's tracked file list, then writes Directory nodes + CONTAINS edges to kuzu via `src/graph-db.ts`. For each directory it also checks disk for `<dir>/README.md` (or `readme.md` / `README.rst`); if present, content (truncated to ~1 KB) becomes the dir's `summary` with `summary_source='readme'`. Otherwise the scanner synthesizes a deterministic **structural** summary from the directory's immediate file + subdir names (`summary_source='structural'`) — so every node is non-empty and reachable by `world_model_search`, never `NULL`.

Re-running `scan_run` is summary-preserving via MERGE — existing nodes update structural fields and refresh README-derived summaries.

`scan_run` also has one SQLite side effect outside the graph: a resource-discovery pass (#124/#846) reconciles locally-present capabilities — project-local skills, enabled plugins, configured MCP servers — into the trajectory DB's `cheatcodes` table (`origin='installed'`, `source_url='scan_discovered'`). That write lands in SQLite, not kuzu; the graph itself stays Directory-nodes-only. See [`CHEATCODES.md`](./CHEATCODES.md).

## Concurrency

kuzu is **single-writer**: only one process may hold the database's write lock, so a `scan_run` can collide with another opener (e.g. the SessionStart prescan warming the graph). `src/graph-db.ts` opens with bounded exponential backoff — up to 8 attempts starting at 50 ms — retrying only on a write-lock error and rethrowing any non-lock error (missing binary, corrupt file) immediately. When the retries exhaust, the open surfaces as `graph_db_open_failed`, and `scan_run` reports that distinct error rather than a phantom "scan already running" — restart the session to retry (#590/591).

## Querying

`world_model_get(repo, path, depth)` returns a directory tree. Implementation reads all Directory nodes for the repo from kuzu, then builds the tree in TypeScript by linking each node to its `parent_path`. Default `depth=2` (root + immediate children); `depth=null` returns the full subtree.

`world_model_search(query, mode='hybrid')` queries kuzu for directories whose `summary` or `path` matches the query.

| Mode | Behavior today | Follow-up |
|---|---|---|
| `keyword` | Substring CONTAINS over summary + path; constant score | Real FTS via kuzu's FTS extension |
| `semantic` | Returns `warning: 'semantic_unavailable'` | bge-small embeddings via kuzu's vector extension |
| `hybrid` (default) | Keyword hits + `semantic_unavailable` warning | RRF over FTS + vector |

## When bro reaches for it

| Situation | Bro's move |
|---|---|
| Cold session, code-touching ask | `world_model_get(depth=2)` |
| "Where in this codebase does X live" | `world_model_search(query='X', mode='hybrid')` |
| Zoom into one part | `world_model_get(path='src/api', depth=1)` |
| File-level detail (rare) | direct Read with explicit paths |

## Consumers

`task_brief(task_id)` (a composite in `tools/composites.ts`) is the world model's main programmatic consumer: it parses a task spec's `## Files`, resolves those directories against the graph (each dir's summary + its children's), and bundles that with the task row + the issue's discussion thread into one read. swe receives this brief instead of orchestrating `task_get` + `world_model_get` + `discussion_search` itself — the Architect→SWE handoff. Decision record: issue #300.

## Design history

The world model has had three substrates, each replacing the last:

- **`file_registry` (v6)** — one row per file (md5 + an LLM summary). Wrong granularity (a file summary says what a file *contains*, not what part of the system it *serves*), drift-sensitive (a one-line edit cleared the summary), and token-heavy. Dropped in v7.
- **SQLite `directories` table (v7)** — the dir-level model as a stepping stone inside the existing trajectory DB. It validated that a README-first directory map is the right cold-start surface: ~10× fewer rows than per-file, and directory summaries change monthly (a part's role) rather than per-commit (a file's contents). Dropped in v8.
- **kuzu graph (v8, current)** — the same dir-level model on a graph engine, the right substrate for the import/call relations that follow. Schema v8 drops the SQLite `directories` / `directories_fts` / `directories_embeddings` tables; the world model rebuilds from `/scan` on first boot.

Per-file md5 + summary state is not part of the world model — leaf-zoom happens via direct `Read` on demand.
