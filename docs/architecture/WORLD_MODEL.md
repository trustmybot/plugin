# World Model

Bro is the architect of every project it works on. The world model is the stable, queryable mental picture bro reasons from — built by `scan_run`, refreshed lazily, queried on every cold start.

## Substrate: kuzu graph database

The world model lives in a dedicated **kuzu** graph database at `<project>/.claude/tmb/world-model.kuzu/`, separate from the standard trajectory DB. A custom `TRAJECTORY_DB_PATH` uses `<db-basename>.world-model.kuzu` so separate SQLite files cannot share one graph. This is by design:

| | Graph DB (kuzu) | Trajectory DB (SQLite) |
|---|---|---|
| Content | Project mental model: dirs and files as nodes, each file with a one-line purpose; parent/import/call relations as edges | Workflow audit: issues, tasks, discussions, validation, plugin metadata |
| Engine | kuzu (embedded, single file, MIT, Cypher) | SQLite via node:sqlite |
| Bro's use | "What does this project look like?" / "Where does X live?" / "What depends on what?" | "What did we decide?" / "What's open?" / "What did SWE commit?" |

**Why a graph DB.** Directory structure — and the import/call relations layered on top of it — is graph-shaped, so a graph engine turns refactor-blast-radius and dependency queries into single traversals instead of recursive SQL. kuzu also carries its own vector + full-text indexes, so semantic and keyword search travel with the graph rather than in a parallel SQLite store, and the trajectory DB stays purpose-pure as the workflow audit.

## Schema

```
NODE Directory   { key (PK), repo, path, parent_path, summary, summary_source, summary_updated_at, file_count }
EDGE CONTAINS    (Directory) → (Directory)    // parent → child
NODE File        { path (PK), repo, dir, purpose, purpose_source, content_md5, size_bytes, last_commit_sha, updated_at }
EDGE HAS_FILE    (Directory) → (File)         // containing directory → file
```

kuzu requires single-column primary keys. A Directory `key` is the JSON tuple `["<repo>","<path>"]`; a File `path` is `<repo>/<repo-relative path>` (repo names are directory basenames, so the first `/` separates the two). `dir` is the file's repo-relative directory, the `path` of the Directory that owns its `HAS_FILE` edge. Opening a graph runs every `CREATE ... IF NOT EXISTS`, so a graph built before File existed gains the File and HAS_FILE tables in place; the next `scan_run` fills them.

**File purpose.** `purpose` is one line saying what the file is for; `purpose_source` records who wrote it:

| `purpose_source` | Writer |
|---|---|
| `swe` | the swe that edited the file (typed writer at task close — a later slice) |
| `docstring`, `comment`, `jsdoc`, `frontmatter`, `heading`, `manifest` | deterministic extraction at scan (see Population) |
| `none` | nothing extractable: binary, empty, or an unrecognised shape; `purpose` is `''` |

Writer priority is swe > extraction: a scan never replaces an `swe` purpose. Freshness is keyed by `content_md5` — an unchanged hash keeps the row as written, a changed hash makes the scan re-extract (or, for an `swe` row, refresh only the md5/size/sha).

Follow-up slices add `Symbol`, `IMPORTS`, `CALLS`, `DEFINES` nodes + edges for code-structure reasoning.

## Population

`scan_run` walks the session dir for git repos, derives the unique directory set from each repo's tracked file list, then writes Directory nodes + CONTAINS edges and File nodes + HAS_FILE edges to kuzu via `src/graph-db.ts`. `scripts/scan.sh` supplies each tracked file's `size_bytes`, `content_md5` and `last_commit_sha`.

**Repos.** The session dir itself is always scanned. A repo below it is skipped, with one `scan_skipped` audit row per path and reason, when its path below the session dir has a dot-prefixed segment (`dot_dir`, e.g. `.tmp-*/proj`), an enclosing repo ignores it (`git_ignored`), or it has no commit (`no_commits`). A `repos` row under the session dir that the scan does not find is deleted, unless a task or another row still references it; such a row is kept and listed in the result's `repos_stale_kept` (`name`, `path`, `reason`: `task_referenced` or `row_referenced`).

**Files.** For each tracked file the scan looks up its File node:

- absent, or `content_md5` differs → read at most the first 4 KB, run `extractPurpose` (`src/file-purpose.ts`), upsert the row with `updated_at` = scan time;
- `content_md5` equal → leave the row untouched (purpose and `updated_at` preserved);
- existing row has `purpose_source='swe'` and the md5 differs → refresh md5/size/sha/`updated_at`, keep `purpose` and `purpose_source`.

File nodes whose path is gone from the repo's scan are deleted, and so are all File nodes of a repo that left the workspace; `repo_rename` re-keys them with the Directory nodes. The 4 KB head is the only file read; file bodies are never stored. The graph stores purposes raw; because they come from file contents, every read path wraps them in `<untrusted-content source="file-purpose">` delimiters (the same `frameUntrusted` framing README summaries get), so agents treat them as data.

**Extraction rules** (pure, by extension or file name; whitespace collapsed, comment markers stripped, cut at the first sentence end or 200 characters):

| File | Purpose from | `purpose_source` |
|---|---|---|
| `.py` | module docstring (after any shebang / comment lines) | `docstring` |
| `.ts`, `.js`, `.mjs` | a JSDoc block with `@file` / `@fileoverview`, else the first comment block | `jsdoc` / `comment` |
| `.ts`, `.js`, `.mjs`, `.sh`, `.pl`, `.sql` | first comment block (`//`, `/* */`, `#`, `--`) after any shebang; license / SPDX / copyright and linter-directive lines are skipped | `comment` |
| `.md` | frontmatter `description:`, else the first H1 plus the first sentence of the paragraph under it | `frontmatter` / `heading` |
| `package.json`, `plugin.json`, `marketplace.json` | top-level `description` | `manifest` |

A NUL byte in the head (binary), an empty head, or no match yields `{purpose: '', source: 'none'}`.

**Directories.** For each directory the scan checks disk for `<dir>/README.md` (or `readme.md` / `README.rst`); if present, content (truncated to ~1 KB) becomes the dir's `summary` with `summary_source='readme'`. Otherwise the scanner synthesizes a deterministic **structural** summary (`summary_source='structural'`): `<dir>/ — N files; <untrusted-content source="file-purpose"> <name>: <purpose>; … </untrusted-content>` with up to 5 file purposes sorted by name, framed once on a single line so the depth-2 first-line trim keeps the whole frame, or the immediate file names when no file has a purpose, then `subdirs: …` — so every node is non-empty and reachable by `world_model_search`, never `NULL`.

Re-running `scan_run` is summary-preserving via MERGE — existing nodes update structural fields and refresh README-derived summaries.

`scan_run` also has one SQLite side effect outside the graph: a resource-discovery pass (#124/#846) reconciles locally-present capabilities — project-local skills, enabled plugins, configured MCP servers — into the trajectory DB's `cheatcodes` table (`origin='installed'`, `source_url='scan_discovered'`). That write lands in SQLite, not kuzu; the graph holds only the Directory and File layers. See [`CHEATCODES.md`](./CHEATCODES.md).

## Concurrency

kuzu is **single-writer**: only one process may hold the database's write lock, so a `scan_run` can collide with another opener (e.g. the SessionStart prescan warming the graph). `src/graph-db.ts` opens with bounded exponential backoff — up to 8 attempts starting at 50 ms — retrying only on a write-lock error and rethrowing any non-lock error (missing binary, corrupt file) immediately. When the retries exhaust, the open surfaces as `graph_db_open_failed`, and `scan_run` reports that distinct error rather than a phantom "scan already running" — restart the session to retry (#590/591).

## Querying

`world_model_get(repo, path, depth)` returns a directory tree. Implementation reads all Directory nodes for the repo from kuzu, then builds the tree in TypeScript by linking each node to its `parent_path`. Default `depth=2` (root + immediate children); `depth=null` returns the full subtree.

- **Zoom-in** (`path` names a directory): the returned node also carries `files: [{path, purpose, purpose_source, content_md5}]` — that directory's own files, sorted by path, `path` repo-relative, each non-empty `purpose` framed as `file-purpose` untrusted content. Children never carry file arrays.
- **Root call** (`path` omitted or `''`): the response adds `coverage: {files, with_purpose, by_source: {<purpose_source>: n}}` for the repo, so bro sees how much of the repo has a purpose. The default depth-2 tree carries no file arrays, so the cold-start call stays directory-sized.

`world_model_search(query, mode='hybrid')` queries kuzu for directories whose `summary` or `path` matches the query and for files whose `purpose` or `path` matches it. Each result carries `kind: 'dir'` (with `summary`, `summary_source`, `file_count`) or `kind: 'file'` (with `dir`, a framed `purpose`, `purpose_source`); directories come first, capped at `k` results overall.

| Mode | Behavior today | Follow-up |
|---|---|---|
| `keyword` | Substring CONTAINS over dir summary + path and file purpose + path; constant score | Real FTS via kuzu's FTS extension |
| `semantic` | Returns `warning: 'semantic_unavailable'` | bge-small embeddings via kuzu's vector extension |
| `hybrid` (default) | Keyword hits + `semantic_unavailable` warning | RRF over FTS + vector |

## When bro reaches for it

| Situation | Bro's move |
|---|---|
| Cold session, code-touching ask | `world_model_get(depth=2)` |
| "Where in this codebase does X live" | `world_model_search(query='X', mode='hybrid')` |
| Zoom into one part | `world_model_get(path='src/api', depth=1)` — includes each file's purpose |
| File-level detail (rare) | direct Read with explicit paths |

## Consumers

`task_brief(task_id)` (a composite in `tools/composites.ts`) is the world model's main programmatic consumer: it parses a task spec's `## Files`, resolves those directories against the graph (each dir's summary + its children's), and bundles that with the task row + the issue's discussion thread into one read. swe receives this brief instead of orchestrating `task_get` + `world_model_get` + `discussion_search` itself — the Architect→SWE handoff. Decision record: issue #300.

## Design history

The world model has had three substrates, each replacing the last:

- **`file_registry` (v6)** — one row per file (md5 + an LLM summary). Wrong granularity (a file summary says what a file *contains*, not what part of the system it *serves*), drift-sensitive (a one-line edit cleared the summary), and token-heavy. Dropped in v7.
- **SQLite `directories` table (v7)** — the dir-level model as a stepping stone inside the existing trajectory DB. It validated that a README-first directory map is the right cold-start surface: ~10× fewer rows than per-file, and directory summaries change monthly (a part's role) rather than per-commit (a file's contents). Dropped in v8.
- **kuzu graph (v8, current)** — the same dir-level model on a graph engine, the right substrate for the import/call relations that follow. Schema v8 drops the SQLite `directories` / `directories_fts` / `directories_embeddings` tables; the world model rebuilds from `/scan` on first boot.

File nodes bring per-file state back on the graph with the two `file_registry` faults fixed: a purpose is one deterministic line (what the file is for, not what it contains) at zero token cost, and an edit only re-extracts when the content hash changes while an swe-written purpose survives it.
