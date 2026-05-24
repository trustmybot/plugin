# ADR 0002 — Graph DB as Bro's World Model (supersedes 0001)

Date: 2026-05-23
Status: accepted

## Context

ADR 0001 picked SQLite + a `directories` table as the v0.7 world-model substrate. That was a stepping stone — implementable in the existing trajectory DB, no new dependency, fast to ship. It got the dir-level summary surface working, validated the navigation pattern, and proved the world-model concept end-to-end.

But the architecture call we'd actually agreed on earlier in the v0.7 design conversation was cleaner:

| Substrate | Role |
|---|---|
| **Graph DB** | Project mental model — dirs (and later files / symbols) as nodes, parent / import / call relations as edges. |
| **Trajectory DB (SQLite)** | Workflow audit — issues, tasks, discussions, validation, plugin metadata. |

The `directories` table in the trajectory DB blurred that split. It worked, but it puts code-structure data in the wrong substrate and forecloses graph-shaped queries that the real world model needs (refactor blast radius, callers, import chains).

## Decision

The world model moves out of the trajectory DB into a dedicated **kuzu** graph database file at `<project>/.claude/tmb/world-model.kuzu`. kuzu is the right fit:

- Embedded single-file engine, MIT-licensed. Matches the trajectory DB's no-server ethos.
- Native Cypher-like queries with first-class graph traversals.
- Has vector + full-text search built in — the bge-small embeddings + keyword index travel with the graph rather than living in a separate SQLite parallel.
- Official Node bindings (`kuzu` npm package, currently 0.11.x).

The trajectory DB stops holding world-model state. Schema v8 drops the `directories` / `directories_fts` / `directories_embeddings` tables — the same way v7 dropped `file_registry`. What stays in SQLite: everything workflow-shaped — `issues`, `tasks`, `discussions`, `audit`, `validation_attempts`, plus the catalogs (`agents`, `skills`, `commands`, `rules`), the metadata (`plugin_meta`, `plugin_config`, `repos`), and observability (`agent_runs`, `pr_review_runs`, `debug_trajectory`, `eval_results`).

### Initial graph schema

```
NODE Directory   { repo, path, summary, summary_source, summary_updated_at, file_count }
EDGE CONTAINS    (Directory) → (Directory)    // parent → child
```

Future slices add:

```
NODE File        { repo, path, language, last_seen_sha }
EDGE LIVES_IN    (File) → (Directory)
NODE Symbol      { kind, name, defined_in_file_id }
EDGE DEFINES     (File) → (Symbol)
EDGE IMPORTS     (File) → (File)              // module-level
EDGE CALLS       (Symbol) → (Symbol)          // function-level
```

`world_model_get` / `world_model_search` keep their MCP-tool names but their handlers query kuzu instead of SQLite. The interface bro sees doesn't change.

### Tool surface

| Tool | Query shape |
|---|---|
| `world_model_get(repo, path, depth)` | Cypher: `MATCH (root:Directory {repo: $repo, path: $path})-[:CONTAINS*0..$depth]->(d) RETURN d` |
| `world_model_search(query, mode)` | kuzu FTS index on `Directory.summary` (keyword) + kuzu vector index on summary embedding (semantic); RRF for hybrid |
| `world_model_impacts(file)` (slice 2+) | `MATCH (f:File {path: $path})<-[:IMPORTS*1..]-(dependents) RETURN dependents` |
| `world_model_callers(symbol)` (slice 3+) | `MATCH (s:Symbol {name: $name})<-[:CALLS*1..]-(callers) RETURN callers` |

## Consequences

**Wins**
- Right substrate for the work. Refactor blast radius + dependency reasoning become single-query operations instead of recursive CTEs that don't scale.
- Vector + FTS travel with the graph; no second SQLite for indexes.
- Trajectory DB becomes purpose-pure — just the workflow audit, matching the user's mental model.
- Future slices (call graph, import graph) layer onto the same engine without new infra.

**Trade-offs**
- New native dependency. kuzu ships binary modules per platform; CC's plugin install must work on macOS + Linux + Windows for parity with the rest of TMB.
- Two persistence files instead of one (`trajectory.db` + `world-model.kuzu`). Backup / migration / debug commands need to know about both.
- The v7 → v8 migration on existing installs has to drain `directories` / `directories_fts` / `directories_embeddings` into kuzu before dropping the tables, or accept that the world model rebuilds from a fresh `/scan` on first use (acceptable — it's cheap).
- `directories` is a known reload-stable table for tests; the test pyramid needs equivalent fixtures targeting the kuzu file.

**Follow-up work (this milestone)**
1. Slice 1 (this commit): kuzu dep + ADR + schema sketch.
2. Slice 2: kuzu DB module + `world_model_get` rewired against kuzu + scan_run writes Directory nodes / CONTAINS edges.
3. Slice 3: `world_model_search` against kuzu's FTS + vector indexes; embedding backfill targets kuzu.
4. Slice 4: schema v7 → v8 migration drops `directories*` tables from trajectory DB; data is re-derived from `/scan` on first boot.
5. Slice 5: doc reorg (WORLD_MODEL.md, ERD.md, REFERENCE.md) leads with graph substrate.
6. Slice 6: L0–L4 test fixtures for kuzu; L5/L6 row outcome SQL relearns to introspect kuzu instead of SQLite `directories`.

`File` / `IMPORTS` / `CALLS` / `DEFINES` nodes + edges are an explicit follow-up — out of scope for v0.7.0.

## Relation to ADR 0001

ADR 0001 stays as a historical record. Its "directories in SQLite" decision was a stepping stone — necessary to validate the navigation pattern and the world-model concept before committing to a new dependency. ADR 0002 supersedes it on the substrate question.
