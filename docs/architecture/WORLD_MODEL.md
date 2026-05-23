# World Model

Bro is the architect of every project it works on. The world model is the stable, queryable mental picture bro reasons from — built once by `scan_run`, refreshed lazily, queried on every cold start.

## Shape

The substrate is the `directories` table in the trajectory DB. One row per directory in each scanned repo.

```
directories
├─ id                    -- INTEGER PRIMARY KEY
├─ repo                  -- which repo this dir lives in
├─ path                  -- repo-relative path; '' for repo root
├─ parent_path           -- repo-relative path of the enclosing dir; NULL for repo root
├─ summary               -- README.md content (truncated to ~1 KB) OR LLM-derived OR NULL
├─ summary_source        -- 'readme' | 'llm' | 'manual'
├─ summary_updated_at    -- last summary write
├─ file_count            -- cached count of files directly in this dir
```

Companion tables: `directories_fts` (keyword search over summary + path), `directories_embeddings` (semantic search via bge-small).

## Population

`scan_run` populates the table. For each unique directory in the discovered file set:

1. Insert the row with `path` + `parent_path` + `file_count`.
2. Check disk for `<repo_path>/<dir>/README.md` (or `readme.md`, `README.rst`).
3. If present: read content, truncate to ~1 KB, store with `summary_source='readme'`. README-derived summaries are author-curated and high-trust by construction.
4. If absent: leave `summary=NULL`. Lazy fill is the agent's responsibility on first ask.

Re-running `scan_run` is idempotent: existing rows keep their `summary` unless the README file content changed.

## Querying

`world_model_get(repo, path, depth)` returns a tree:

```json
{
  "repo": "plugin",
  "root": {
    "path": "",
    "summary": "TMB plugin for Claude Code — agentic workflow harness.",
    "file_count": 3,
    "children": [
      {
        "path": "agents",
        "summary": "Backbone agent prompts (swe, pr-reviewer).",
        "file_count": 2,
        "children": []
      }
    ]
  }
}
```

`depth` defaults to 2 (root + immediate children). `depth=0` returns just the named directory; `depth=null` returns the full subtree.

`world_model_search(query, mode='hybrid')` searches dir summaries — same shape as `discussion_search`. Returns ranked dir paths with their summaries.

## When bro reaches for it

| Situation | Bro's move |
|---|---|
| Cold session, code-touching ask | `world_model_get(depth=2)` — full project map |
| Looking for "where in this codebase does X live" | `world_model_search(query='X')` |
| Zoom into one part | `world_model_get(path='src/api', depth=1)` |
| Need file-level detail (rare) | `file_registry_search` or direct Read |

## Relation to `file_registry`

`file_registry` continues to exist as the file-level index during the migration window. Its role is leaf-zoom — when dir-level isn't fine enough. The primary navigation surface is `world_model_get`. `file_registry.summary` becomes lazy (filled only when an agent reads inside a specific file).

`file_registry` infrastructure removal is tracked separately and lands once every consumer (hooks, skills, agents, CLAUDE.md) has migrated to world-model surfaces.
