# World Model

Bro is the architect of every project it works on. The world model is the stable, queryable mental picture bro reasons from — built by `scan_run`, refreshed lazily, queried on every cold start.

## Substrate: kuzu graph database

The world model lives in a dedicated **kuzu** graph database at `<project>/.claude/tmb/world-model.kuzu/`, separate from the trajectory DB. This is by design:

| | Graph DB (kuzu) | Trajectory DB (SQLite) |
|---|---|---|
| Content | Project mental model: dirs as nodes, parent/import/call relations as edges | Workflow audit: issues, tasks, discussions, validation, plugin metadata |
| Engine | kuzu (embedded, single file, MIT, Cypher) | SQLite via node:sqlite |
| Bro's use | "What does this project look like?" / "Where does X live?" / "What depends on what?" | "What did we decide?" / "What's open?" / "What did SWE commit?" |

See ADR 0002 for the substrate decision (supersedes 0001).

## Schema

Initial schema (v0.7 ship):

```
NODE Directory   { key (PK), repo, path, parent_path, summary, summary_source, summary_updated_at, file_count }
EDGE CONTAINS    (Directory) → (Directory)    // parent → child
```

`key` is the composite string `<repo>:<path>` — kuzu requires single-column primary keys.

Follow-up slices (post-v0.7) add `File`, `Symbol`, `IMPORTS`, `CALLS`, `DEFINES` nodes + edges for code-structure reasoning.

## Population

`scan_run` walks the session dir for git repos, derives the unique directory set from each repo's tracked file list, then writes Directory nodes + CONTAINS edges to kuzu via `src/graph-db.ts`. For each directory it also checks disk for `<dir>/README.md` (or `readme.md` / `README.rst`); if present, content (truncated to ~1 KB) becomes the dir's `summary` with `summary_source='readme'`. Otherwise `summary=NULL`.

Re-running `scan_run` is summary-preserving via MERGE — existing nodes update structural fields and refresh README-derived summaries.

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

## What was replaced

ADR 0001 placed the dir-level world model in a SQLite `directories` table — a stepping stone to validate the navigation pattern. ADR 0002 moves it to kuzu, the right substrate for graph-shaped data. Schema v8 drops the SQLite `directories` / `directories_fts` / `directories_embeddings` tables; the world model rebuilds from `/scan` on first boot under v8.

The earlier per-file `file_registry` (v6) was dropped in v7. Per-file md5 + summary state is not part of the world model — leaf-zoom happens via direct Read on demand.
