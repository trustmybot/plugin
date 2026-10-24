# ADR 0001: World model structural layer — own tree-sitter index plus LSP checks

- **Status:** Accepted (2026-10-24; validation 5 open)
- **Date:** 2026-10-24
- **Issue:** GH 1680 · coordination: GH 1693
- **Deciders:** Human (accepted 2026-10-24), bro (proposal)

## Context

The world model should be a mind map: an agent understands an area of the project without re-reading the code on every task. Today it is a table of contents. `wm_directories` and `wm_files` (`mcp/trajectory-server/src/schema.sql:557`) hold a directory tree, a one-line purpose per file, and nothing else: no symbols, no calls, no imports. Agents still `Read` and `Grep` to understand anything. [WORLD_MODEL.md](../WORLD_MODEL.md) already plans "symbol, import and call tables" as a follow-up slice; this ADR decides how to build them.

GH 1680 splits the target into two layers:

- **L1, structural:** symbols, calls, imports and references, kept fresh automatically.
- **L2, concepts:** agent-written subsystem, flow, invariant and decision nodes, anchored to L1 symbols. ADR 0002 decides L2 after its data is in; this ADR fixes the anchor key L2 needs and reserves its table names.

### Evidence

**codegraph spike** (codegraph 1.6.2 against `plugin@d6e444a2`, telemetry off, installer not run). codegraph (MIT, tree-sitter, SQLite) is the strongest off-the-shelf L1, but it parses none of our 387 shell files or 61 SQL files. Its answers are 11–25 KB of verbatim source, 150 of its 182 JS files were `dist/` copies, and its node IDs are line-based (`sha256(file:kind:name:line)`), so L2 cannot anchor to them.

**MVP** (scratch prototype of this decision plus S0 and L2, same snapshot; full report on GH 1680). Ten locate-the-code questions from real issues, five of them held out (their fixes landed after the snapshot):

| | MVP | codegraph | world model today |
|---|---|---|---|
| right file in top 3 | **8/10** | 5/10 | 0/10 (5/10 with an OR fallback, helped by index leakage) |
| answer size | 2.5–3.3 KB | 11–25 KB | 0.3–0.9 KB |
| full index / one-file update | 3.0 s / 0.4–0.5 s | 25 s / 0.46 s | `/scan` only |
| DB size | 9.4 MB | 50 MB | rows in trajectory.db |
| shell functions / SQL objects | 1,142 / 546 | 0 / 0 | none |
| files with no purpose line | 5% | — | 58% |

## Decision

Build L1 ourselves, inside the trajectory DB (GH 1680 option H):

1. **Parsing.** One shared `src/parsing/` module on `web-tree-sitter` (WASM, no native binding) with the typescript, tsx, javascript and bash grammars. Compat's `cmd-analysis` port (GH 1692) reuses the same module, so the repo has one parser stack. SQL uses a DDL extractor for `CREATE TABLE/INDEX/TRIGGER/VIEW`, because no prebuilt SQL WASM exists. Markdown keeps today's heading and README extraction.
   - Pin `web-tree-sitter` 0.25.x. Bash comes from the `tree-sitter-bash` package's own WASM: the `tree-sitter-wasms` bash build crashes under 0.25.
2. **Storage.** Add `wm_symbols` and `wm_edges` beside `wm_files`, under the same rules: repo-relative paths, FTS5 over name, signature and doc, and rows rebuilt from the working tree as a derived cache. No second DB, daemon or writer.

   ```sql
   CREATE TABLE wm_symbols (
     id INTEGER PRIMARY KEY,
     repo TEXT NOT NULL, path TEXT NOT NULL,
     kind TEXT NOT NULL,            -- function, method, class, interface, type, const, sh_function, sql_table, sql_index, sql_trigger, module
     qualified_name TEXT NOT NULL,  -- Class.method; file-local scope for shell
     signature TEXT NOT NULL DEFAULT '',
     doc TEXT NOT NULL DEFAULT '',
     start_line INTEGER, end_line INTEGER,
     body_hash TEXT NOT NULL,       -- normalized body: whitespace and comments stripped
     exported INTEGER NOT NULL DEFAULT 0,
     UNIQUE (repo, path, kind, qualified_name)
   );
   CREATE TABLE wm_edges (
     src_id INTEGER NOT NULL REFERENCES wm_symbols(id) ON DELETE CASCADE,
     dst_id INTEGER REFERENCES wm_symbols(id) ON DELETE SET NULL,
     dst_name TEXT NOT NULL,        -- kept when unresolved
     kind TEXT NOT NULL,            -- calls, imports, instantiates, sources, runs, reads_table, writes_table, indexes, triggers_on
     resolution TEXT NOT NULL,      -- exact, name, unresolved
     line INTEGER
   );
   ```

   `wm_concepts`, `wm_concept_anchors` and `wm_concept_claims` are reserved for L2.
3. **Stable anchor key.** A symbol is `repo + path + kind + qualified_name`, plus `body_hash` for staleness. L2 anchors use this key; line numbers are data, not identity.
4. **Scope.** Index the working tree: tracked files plus untracked files git does not ignore (`git ls-files --cached --others --exclude-standard`). A new file must be visible before its first commit; the MVP missed one until this was fixed. A default exclude list skips build output (`dist/`, `*.map`, lockfiles, vendored code).
5. **Freshness.** Re-index a file when its `content_md5` changes (a no-op pass over 654 files takes 0.3 s). The catch-up runs at scan, at task close and on server connect. The task-close trigger is a TS gate in Compat's hook registry (GH 1692), not a new `.sh` hook. A query that touches a file not yet re-indexed says so. A file watcher is deferred until catch-up proves too slow.
6. **Answer shape.** Compact symbol cards by default: signature, location, callers, callees and covering tests. Source only on request.
7. **Precision.** For edits that need exact references (a rename, a signature change), agents use Claude Code's LSP tool. Calls resolve by name (about 51% of call edges resolve in `plugin/`; table edges 94–97%), so results say "found by name", never "all callers".
8. **Compatibility.** `wm_directories`, `wm_files` and the `world_model_get` / `world_model_search` outputs stay additive-only: `dashboard/server/queries.ts` and `dashboard/test/smoke.sh` read them. `scripts/scan.sh` folds into `scan_run`.
9. **codegraph as reference.** A design reference, not a dependency. We borrow its schema shape, resolution passes and catch-up ideas, with MIT attribution wherever code is adapted.

## Options considered

The full option tables (A–H) are on GH 1680.

| Option | Why not chosen |
|---|---|
| A: codegraph as an external MCP or dependency | Blind to shell, SQL and docs, which are most of this repo. Adds a second SQLite DB, a daemon and a writer right after the kuzu removal consolidated on one file (GH 1632). Telemetry is on by default. Its installer writes into CLAUDE.md, AGENTS.md and GEMINI.md. The bus factor is about 1, and its line-based IDs cannot anchor L2. |
| B: embed codegraph as a library | Bundles about 183k LOC plus WASM grammars into a server whose only runtime dependencies today are `@modelcontextprotocol/sdk` and `@huggingface/transformers`. Still no shell support. |
| C: fork codegraph | About 212k LOC (TS plus Rust) to maintain alone, to gain two extractors. |
| E: LSP only | No persistent graph, so L2 has nothing to anchor to. Every query is a round trip, and shell language servers are weak. Kept as the precision half of H. |
| F: SCIP indexers | Batch-only, one indexer per language, and no shell indexer. |
| G: stack-graphs | Archived by GitHub (2025-09-09). |

## Consequences

**Gains**

- One store answers both "where does X live" and "who calls or writes X" across all four of the repo's languages.
- L2 gets a stable key to anchor to, and a body hash to mark concepts stale. The MVP showed a refactored anchor turning its concept `suspect`, and a second writer of `wm_files` turning an `only_writers_of` claim `broken`, with no LLM involved.
- Freshness rides on the `content_md5` machinery `scan_run` already has.
- Compat's shell-safety gates get a real bash parser from the same module.

**Costs and risks**

- **We own the indexer.** The MVP is about 600 lines of JS covering extraction, resolution, search and concepts; production TS with tests is likely 2–3× that.
- **Name-only resolution.** Sourced files, dynamic `$cmd` calls, `eval`, overloads and dynamic dispatch are missed or mis-linked.
- **Bundle size.** The runtime is 0.36 MB (JS glue plus `tree-sitter.wasm`). Grammars: typescript 2.3 MB, tsx 2.4 MB, bash 1.4 MB, javascript 0.65 MB. All four add about 7.1 MB to a 15 MB `dist/` (+47%). Dropping tsx saves 2.4 MB but leaves `.tsx` files at file level only.
- **Coverage gap.** TS/JS symbols are 10.1% below codegraph's (2,255 vs 2,509), from nested functions and thin test-file extraction.
- **Schema change.** New tables mean one schema bump, number claimed on GH 1693 when provisioned (S0 holds v43), with a migration and an `ERD.md` update.
- **Sequencing.** `package.json` and `bun.lock` are serialized behind Compat slice 1 (GH 1693), so the indexer starts only after that merges.
- **Prompt and doc updates.** The persona's world-model text and `WORLD_MODEL.md` must describe the new tables and tools. The prompt change waits for GH 1671 and needs Human sign-off.

## Validation

| # | Check | Result |
|---|---|---|
| 1 | TS/JS symbols within ±10% of codegraph; shell functions and SQL tables found | **Near miss:** −10.1%. 1,142 shell functions and 289 SQL tables found. Closing the gap needs nested-function extraction. |
| 2 | Locate test: the five spike questions, under 2k tokens each | **3/5 in the top 3, 5/5 in the top 5**; 8/10 in the top 3 on the wider ten-question set. Answers are about 800 tokens. |
| 3 | A 1-file edit is visible without `/scan`; a stale file is flagged | **Pass in the prototype:** a one-file re-index takes 0.4–0.5 s. The task-close trigger itself is untested until the TS gate exists. |
| 4 | Bundle growth recorded and accepted by the Human | **Accepted** by the Human on 2026-10-24 (+7.1 MB, +47%). |
| 5 | swe and bro A/B on 3–5 past tasks, per `benchmarks/BENCHMARKING.md` | **Open**; runs once L1 is in `dev` (S4). |
