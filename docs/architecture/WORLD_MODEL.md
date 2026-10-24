# World Model

Bro is the architect of every project it works on. The world model is the stable, queryable mental picture bro reasons from — built by `scan_run`, refreshed lazily, queried on every cold start.

## Substrate: tables in the trajectory DB

The world model lives in the trajectory DB (`<project>/.claude/tmb/trajectory.db`) as its own `wm_` tables, beside the workflow audit but with no foreign key into it: it is a derived cache that `scan_run` rebuilds from git (GH 1632).

| | World model (`wm_` tables) | Workflow tables |
|---|---|---|
| Content | Project mental model: dirs and files, each file with a one-line purpose | Workflow audit: issues, tasks, discussions, validation, plugin metadata |
| Bro's use | "What does this project look like?" / "Where does X live?" | "What did we decide?" / "What's open?" / "What did SWE commit?" |

**Why SQLite.** The world model moved off a sibling embedded graph DB (schema v8 to v41). That engine brought a single-writer lock that a second session or an orphaned server could hold (`graph_db_open_failed`), a native destructor segfault at exit on Node 24/macOS, a native binding that could be missing after install, and a 531 MB install from an archived upstream, while its full-text and vector extensions were never wired up. The tree walk is one recursive CTE, and keyword and semantic search reuse the FTS5 and embedding machinery the workflow tables already have.

## Schema

```
wm_directories            { id (PK), repo, path, parent_path, summary, summary_source, summary_updated_at, file_count, summary_sha, commits_behind, dead_refs }  UNIQUE (repo, path)
wm_files                  { id (PK), repo, path, dir, purpose, purpose_source, content_md5, size_bytes, last_commit_sha, updated_at }  UNIQUE (repo, path)
wm_directories_fts        FTS5 over (path, summary)
wm_files_fts              FTS5 over (path, purpose)
wm_directories_embeddings { dir_id → wm_directories.id, embedding, model_id, embedded_at }
wm_files_embeddings       { file_id → wm_files.id, embedding, model_id, embedded_at }
```

`path` is repo-relative in both tables; the repo root is the directory with `path = ''` and `parent_path` NULL. A directory's parent is the row with the same `repo` whose `path` equals its `parent_path`; a file's directory is the row whose `path` equals its `dir`. Triggers keep the FTS indexes in step with every insert, update and delete, and drop a row's embedding when its path or summary/purpose changes so the next search re-embeds it. Upserts keep the row id, so unchanged rows keep their FTS and embedding entries.

At the `WorldModelGraph` interface (`src/graph.ts`) a directory `key` is the JSON tuple `["<repo>","<path>"]` and a file `path` is `<repo>/<repo-relative path>` (repo names are directory basenames, so the first `/` separates the two).

**File purpose.** `purpose` is one line saying what the file is for; `purpose_source` records who wrote it:

| `purpose_source` | Writer |
|---|---|
| `swe` | the swe that edited the file (typed writer at task close — a later slice) |
| `docstring`, `comment`, `jsdoc`, `frontmatter`, `heading`, `manifest` | deterministic extraction at scan (see Population) |
| `none` | nothing extractable: binary, empty, or an unrecognised shape; `purpose` is `''` |

Writer priority is swe > extraction: a scan never replaces an `swe` purpose. Freshness is keyed by `content_md5` — an unchanged hash keeps the row as written, a changed hash makes the scan re-extract (or, for an `swe` row, refresh only the md5/size/sha).

Follow-up slices add symbol, import and call tables for code-structure reasoning.

## Population

`scan_run` walks the session dir for git repos, derives the unique directory set from each repo's tracked file list, then writes `wm_directories` and `wm_files` rows via `src/graph.ts`, all in one transaction. `scripts/scan.sh` supplies each tracked file's `size_bytes`, `content_md5` and `last_commit_sha`.

**Repos.** The session dir itself is always scanned. A repo below it is skipped, with one `scan_skipped` audit row per path and reason, when its path below the session dir has a dot-prefixed segment (`dot_dir`, e.g. `.tmp-*/proj`), an enclosing repo ignores it (`git_ignored`), or it has no commit (`no_commits`). A `repos` row under the session dir that the scan does not find is deleted, unless a task or another row still references it; such a row is kept and listed in the result's `repos_stale_kept` (`name`, `path`, `reason`: `task_referenced` or `row_referenced`).

**Files.** For each tracked file the scan looks up its `wm_files` row:

- absent, or `content_md5` differs → read at most the first 4 KB, run `extractPurpose` (`src/file-purpose.ts`), upsert the row with `updated_at` = scan time;
- `content_md5` equal → leave the row untouched (purpose and `updated_at` preserved);
- existing row has `purpose_source='swe'` and the md5 differs → refresh md5/size/sha/`updated_at`, keep `purpose` and `purpose_source`.

File rows whose path is gone from the repo's scan are deleted, and so are all rows of a repo that left the workspace; `repo_rename` re-keys them with the directory rows. The 4 KB head is the only file read; file bodies are never stored. The table stores purposes raw; because they come from file contents, every read path wraps them in `<untrusted-content source="file-purpose">` delimiters (the same `frameUntrusted` framing README summaries get), so agents treat them as data.

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

**README drift** (v43, GH 1680). A README summary can go stale while the code under it moves on. For each directory whose README is tracked, the scan runs `git -C <root> …` (via `spawnSync`, bounded by a timeout) and writes three columns:

| Column | Value |
|---|---|
| `summary_sha` | the last commit that touched the README (`git log -1 -- <dir>/<readme>`) |
| `commits_behind` | `git rev-list --count <summary_sha>..HEAD -- <dir> ':!<dir>/<readme>'`: commits under the directory since the README last changed |
| `dead_refs` | a JSON array of repo-relative paths the README names that no longer exist; `'[]'` when there are none |

Dead references are found in the full README (not the 1 KB summary clip), with any `<untrusted-content …>` framing stripped first. The candidates are markdown link targets and backtick spans that look like paths. A backtick path is checked only when it has no `/` (and has a file extension) or its first segment is a tracked directory, at the repo root or under the README's directory. Anything starting with `..`, under `dist/`, or containing `${`, `<` or `*` is skipped. A candidate is dead when it exists neither relative to the README's directory nor relative to the repo root, and it is a markdown link or git deleted it. A ref with a `/` counts as deleted only when it matches a deleted path exactly, relative to the repo root or the README's directory; a bare filename counts only when a deleted file has that basename and no file tracked today does (a deleted `.claude/agents/swe.md` does not flag `swe.md` while `agents/swe.md` exists). The deleted set comes from one `git log --diff-filter=D --name-only --format=` and the tracked basenames from one `git ls-files`, each per repo per scan. Git runs outside the write transaction, so it never holds the DB lock.

All three columns stay `NULL` for structural directories and for roots that are not git repos. Any git failure leaves them `NULL` and never fails the scan.

Re-running `scan_run` is summary-preserving via upsert — existing rows update structural fields and refresh README-derived summaries.

`scan_run` also has one SQLite side effect outside the graph: a resource-discovery pass (#124/#846) reconciles locally-present capabilities — project-local skills, enabled plugins, configured MCP servers — into the trajectory DB's `cheatcodes` table (`origin='installed'`, `source_url='scan_discovered'`). That write lands in the workflow tables; the world model holds only the directory and file layers. See [`CHEATCODES.md`](./CHEATCODES.md).

## Concurrency

The world model shares the trajectory DB's handle and its WAL-mode, busy-timeout concurrency: a scan writes inside one immediate transaction, so readers in other sessions see the old map or the new one, never half of each. There is no separate lock to contend for.

## Querying

`world_model_get(repo, path, depth)` returns a directory tree. Every directory node carries `summary_sha`, `commits_behind`, `dead_refs` (an array) and `trust`. A recursive CTE over `parent_path` selects the directory and its descendants down to `depth`; the tree is then built in TypeScript by linking each row to its parent. Default `depth=2` (root + immediate children); `depth=null` returns the full subtree.

- **Zoom-in** (`path` names a directory): the returned node also carries `files: [{path, purpose, purpose_source, content_md5}]` — that directory's own files, sorted by path, `path` repo-relative, each non-empty `purpose` framed as `file-purpose` untrusted content. Children never carry file arrays.
- **Root call** (`path` omitted or `''`): the response adds `coverage: {files, with_purpose, by_source: {<purpose_source>: n}}` for the repo, so bro sees how much of the repo has a purpose. The default depth-2 tree carries no file arrays, so the cold-start call stays directory-sized.

`world_model_search(query, mode='hybrid')` searches directories by `path` + `summary` and files by `path` + `purpose`. Each result carries `kind: 'dir'` (with `summary`, `summary_source`, `file_count`) or `kind: 'file'` (with `dir`, a framed `purpose`, `purpose_source`) and a `score`, capped at `k` results overall. Directory results also carry `summary_sha`, `commits_behind`, `dead_refs` and `trust`.

`trust` reads the drift columns: `'current'` when `commits_behind` is 0 and there are no dead refs, `'drifting(n)'` when `commits_behind` is n > 0, with `'dead_refs(k)'` appended after `, ` when the README names k dead paths (`'dead_refs(k)'` alone on an otherwise current README), and `null` for structural directories and non-git roots.

**Sentence queries.** Keyword search first requires every query term (an FTS5 AND). When that matches no row, it reruns as an OR of the terms minus a small English stopword list, still ranked by bm25, so a question like "where does the invoice code live" finds the invoice directory. The response's `match` key says which ran: `'all_terms'` or `'any_term'`.

| Mode | Behavior |
|---|---|
| `keyword` | FTS5 bm25 ranking over path + summary/purpose (all terms, else any non-stopword term), then case-insensitive substring hits at score 0 |
| `semantic` | Cosine over bge-small embeddings of `path: summary` / `path: purpose`. Vectors come from the q8 (quantized) bge-small model and are stored under `model_id` `Xenova/bge-small-en-v1.5@q8`; rows stored under another id are re-embedded by the backfill |
| `hybrid` (default) | Reciprocal rank fusion (k = 60) of the keyword and semantic lists for directories and files |

Embeddings are computed on demand: each `semantic` or `hybrid` search embeds up to 50 missing rows per table first and, when more are missing, starts a background backfill. When the embedding model is unavailable, `semantic` and `hybrid` return the keyword hits with `warning: 'semantic_unavailable'`.

## When bro reaches for it

| Situation | Bro's move |
|---|---|
| Cold session, code-touching ask | `world_model_get(depth=2)` |
| "Where in this codebase does X live" | `world_model_search(query='X', mode='hybrid')` |
| Zoom into one part | `world_model_get(path='src/api', depth=1)` — includes each file's purpose |
| File-level detail (rare) | direct Read with explicit paths |

## Consumers

`task_brief(task_id)` (a composite in `tools/composites.ts`) is the world model's main programmatic consumer: it parses a task spec's `## Files`, resolves those directories against the world model (each dir's summary + its children's), and bundles that with the task row + the issue's discussion thread into one read. swe receives this brief instead of orchestrating `task_get` + `world_model_get` + `discussion_search` itself — the Architect→SWE handoff. Decision record: issue #300.

## Design history

The world model has had four substrates, each replacing the last:

- **`file_registry` (v6)** — one row per file (md5 + an LLM summary). Wrong granularity (a file summary says what a file *contains*, not what part of the system it *serves*), drift-sensitive (a one-line edit cleared the summary), and token-heavy. Dropped in v7.
- **SQLite `directories` table (v7)** — the dir-level model as a stepping stone inside the existing trajectory DB. It validated that a README-first directory map is the right cold-start surface: ~10× fewer rows than per-file, and directory summaries change monthly (a part's role) rather than per-commit (a file's contents). Dropped in v8.
- **Embedded graph DB (v8–v41)** — the same dir-level model on a separate graph engine, chosen for the import/call relations to follow. Its single-writer lock, native-binding install and exit-time crashes cost more than the graph queries it never ran. Schema v8 dropped the SQLite `directories` tables.
- **`wm_` tables (v42, current)** — the directory and file layers back in the trajectory DB, with FTS5, embeddings and recursive-CTE tree walks. The old graph files are not migrated; `/scan` rebuilds the map. v43 added the README drift columns (`summary_sha`, `commits_behind`, `dead_refs`) to `wm_directories` in place; they stay `NULL` until the next scan.

File rows bring per-file state back with the two `file_registry` faults fixed: a purpose is one deterministic line (what the file is for, not what it contains) at zero token cost, and an edit only re-extracts when the content hash changes while an swe-written purpose survives it.
