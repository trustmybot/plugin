# ADR 0001 — World Model as Bro's Memory System

Date: 2026-05-23
Status: accepted

## Context

Bro is meant to be the architect of every project it works on. To be a useful architect, bro needs a *world model* of the project — a stable, queryable mental picture it can reason from on every cold start.

The substrate today is `file_registry`: one row per file with `content_md5` + LLM-generated `summary` + FTS5 + bge-small embeddings. Three problems:

1. **Wrong granularity.** A per-file summary describes what one file contains, not what part of the system the file participates in. The unit that explains "what this part of the system does" is the directory.
2. **Drift sensitivity.** md5 is per-file; a 1-line change clears the summary even when the file's role hasn't changed. Population cost is paid repeatedly.
3. **Token cost.** N files × per-file summary is large; agents rarely consume per-file detail when navigating cold.

Concretely: this plugin has ~500 files in ~50 directories. 10× state-row reduction at the directory level, and directory summaries are far more stable than file summaries — they describe the role of a part of the system, which changes monthly, not the contents of one file, which changes per-commit.

A senior engineer reading an unfamiliar project doesn't open every file. They read the project README, then each top-level dir's README if present, and infer the rest from filenames. That's the natural shape for bro's first-move surface.

## Decision

The trajectory DB grows a new primary navigation table: `directories(id, repo, path, parent_path, summary, summary_source, summary_updated_at, file_count)`. Population is README-first: when `scan_run` discovers a directory, if `<dir>/README.md` (or `readme.md` / `README.rst`) exists, its content (truncated to ~1 KB) becomes the directory summary with `summary_source='readme'`. Otherwise the row exists with `summary=NULL`, filled lazily by LLM derivation when an agent first asks about that directory.

A new MCP tool `world_model_get(repo, path, depth)` returns a directory tree with summaries. This becomes bro's primary first-move on a code-touching ask, replacing the file-registry-first navigation pattern.

Directories get the same FTS5 + bge-small embedding parallels as file_registry — `directories_fts` for keyword search and `directories_embeddings` for semantic search, surfaced via `world_model_search(query, mode)`.

`file_registry` stays for now. Its role demotes from primary navigation to leaf-zoom: files remain queryable on-demand when dir-level isn't fine enough. Removal of the `file_registry` infrastructure is a separate, later step once consumers have migrated.

## Consequences

**Wins**
- Bro arrives cold and runs `world_model_get` once — a few KB of dir-level summaries gives a complete project map. Today that costs many `file_registry_search` calls or full file reads.
- README-derived summaries are author-curated, not LLM-fabricated — higher trust by construction, and they refresh naturally on any README edit instead of relying on LLM-write cadence.
- ~10× state-row reduction in the navigation table; summary-refresh cost drops accordingly.
- Sets up the natural unit for future call/import-graph integration (graph nodes live between directories at the right abstraction level).

**Trade-offs**
- Dirs without README need lazy LLM-fill or stay empty. Empty-but-listed is still a win over no-row (agent still sees the dir exists and its file_count).
- Two summary systems coexist during the migration window. Discipline: dir is the primary; file is the leaf-zoom. Documented in `docs/architecture/WORLD_MODEL.md`.
- `scan_run` reads README.md files from disk in addition to enumerating tracked files. Adds bounded I/O to scan but stays inside the existing scan envelope.

**Follow-up work (also v0.7.0)**
1. Doc reorg: `REFERENCE.md` / `FLOWS.md` / `ERD.md` / `ENFORCEMENT.md` / `FILES.md` lead with the world-model story.
2. Update `CLAUDE.md` / `tmb_planning` / `tmb_recovery` to point bro at `world_model_get` as the cold-start move.
3. Hook updates: the registry-cold gate becomes a world-model-cold gate.
4. Drop `file_registry` infrastructure once consumers have migrated.
5. L0–L6 test coverage for the new tools + scan integration.
