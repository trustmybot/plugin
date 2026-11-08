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
wm_files                  { id (PK), repo, path, dir, purpose, purpose_source, content_md5, size_bytes, last_commit_sha, updated_at, symbols_md5 }  UNIQUE (repo, path)
wm_symbols                { id (PK), repo, path, kind, qualified_name, signature, doc, start_line, end_line, body_hash, exported, terms, run_order }  UNIQUE (repo, path, kind, qualified_name)
wm_edges                  { src_id → wm_symbols.id (CASCADE), dst_id → wm_symbols.id (SET NULL), dst_name, kind, resolution, line, hint }
wm_concepts               { id (PK), repo, kind, name, body, status, status_reason, verified_sha, verified_by, verified_at, created_at, updated_at, steps_text }  UNIQUE (repo, name)
wm_concept_steps          { concept_id → wm_concepts.id (CASCADE), ordinal, repo, path, kind, qualified_name, description, handoff, hash_at_verify, trust, trust_reason }  PK (concept_id, ordinal)
wm_concept_claims         { id (PK), concept_id → wm_concepts.id (CASCADE), claim, args, last_result }
wm_directories_fts        FTS5 over (path, summary)
wm_files_fts              FTS5 over (path, purpose)
wm_symbols_fts            FTS5 over (terms, signature, doc), external content on wm_symbols
wm_concepts_fts           FTS5 over (name, body, steps_text), external content on wm_concepts
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
| `structural` | the data-file fallback at scan when the file has no header: JSON/YAML shape, a `.txt` or `changelog.d/` file's directory role, a heading-less Markdown file's first line (GH 1843) |
| `symbols` | the code-file fallback after symbol indexing when the file has no header: its exports, top-level definitions or test titles (GH 1843) |
| `none` | nothing extractable: binary, empty, or an unrecognised shape; `purpose` is `''` |

Writer priority is swe > header extraction > `structural` / `symbols`: a scan never replaces an `swe` purpose, and neither fallback ever overrides a header. Freshness is keyed by `content_md5` — an unchanged hash keeps the row as written, a changed hash makes the scan re-extract (or, for an `swe` row, refresh only the md5/size/sha).

**Symbols (L1, v44, GH 1680).** The structural layer of [ADR 0001](./adr/0001-world-model-structural-layer.md). `src/parsing/` parses TypeScript, TSX, JavaScript and shell with tree-sitter (`web-tree-sitter` plus grammar `.wasm` files shipped in `dist/parsing/`, nothing installed at runtime) and reads SQL DDL and Perl (`.pl`, `.pm`, a `perl` shebang) with patterns. Each file yields:

- one `module` symbol (`qualified_name` = the path, `doc` = the file's header comment) that owns its imports and top-level calls;
- top-level definitions: `function`, `method` (as `Class.method`), `class`, `interface`, `type` (type aliases and enums), `const`, `sh_function`, and from SQL (`.sql` files and DDL in code strings) `sql_table`, `sql_index`, `sql_trigger`. Arrow functions and function expressions count only when bound at the top level, so closures are not indexed, with one exception (GH 1970): an object-literal pair whose value is a call whose argument chain (nested calls, any depth) holds a function value and, in some call, a string literal equal to the pair's key, the self-naming registration idiom of an MCP tool handler (`task_reopen: requireRoles('task_reopen', ['bro'], wrap(async (args) => ...))`), is a `function` named `tool:<key>` spanning the pair, its signature the pair's first line, and owns the calls inside the handler; the enclosing definition gets a `calls` edge to it, so a caller trace from a handler-only helper still reaches the function that registers the tools. In Perl (GH 2284) each named `sub` is a `function` (its package-qualified name kept, a forward declaration skipped) and each name of `use constant NAME => ...` or `use constant { A => ..., B => ... }` a `const` on its own line; POD and anything after `__END__` or `__DATA__` are skipped, and a name starting with `_` is not exported;
- from `hooks/hooks.json`, one `hook` symbol per registered hook, named `<Event>#<pos>:<gate>`, with `run_order` = event rank × 100 + position (Claude Code lifecycle order; events it does not name rank right after `Stop`, in file order) and a `runs` edge to the gate's `mcp/trajectory-server/src/hooks/<gate>.ts` (a direct `.sh` entry: to that script). A router entry (`dist/hooks.js <Event> [part]`) is named by its first gate, its `doc` lists the gates, and it has one such edge per gate of its event, matcher and part in `dist/hooks-router.txt`, `line` holding the gate's position; a `registry.ts` change re-reads them with no change to `hooks.json`. `run_order` is NULL for every other symbol;
- from each file the env readers (`src/env/collect.ts`, `envReaderFor`) recognise — `package.json`, `pyproject.toml`, a Makefile, justfile or Taskfile by basename, `.gitlab-ci.yml` and `.github/workflows/*.yml` by path — one `runner` symbol per runner target (named by its script or target) or CI step (named `ci:<line>`), with `signature` the command, `start_line` = `end_line` its line, and a `covers` edge to each directory the command checks (GH 2326; see **Runners** below);
- edges from each definition: `calls`, `instantiates` (`new X`), `imports`, `sources` and `runs` (shell), `reads_table` and `writes_table` (SQL in strings and heredocs), `indexes` and `triggers_on`, and `reads_config` (GH 2325; schema v60) to each `plugin_config` key a `SELECT ... FROM plugin_config` in its strings reads.

**Config reads** (GH 2325; schema v60). A `reads_config` edge's `dst_name` is the key, `dst_id` NULL and `resolution` `'name'`; no resolution pass rebinds it, and a symbol losing its target never resets it. A key counts when the SELECT names it as `key = 'x'` or `key IN ('a', 'b')`, or as `key = ?` / `key IN (?, ?)` bound by the call's next argument when that is an array of string literals or same-file `const NAME = 'x'` identifiers; `${NAME}` in a SQL template counts for such a const too. A key built at run time (`${key}` of a parameter) and any `INSERT`, `UPDATE`, `DELETE` or `REPLACE` yield no edge.

**Runners** (GH 2326; `src/parsing/runners.ts`). A `covers` edge runs from a `runner` symbol to a repo-relative directory (`dst_name`, no trailing slash, `.` for the repo root) with `dst_id` NULL, `resolution` `'name'` and `line` the runner's line; like `reads_config`, no resolution pass rebinds or resets it. The command is split into shell words and simple commands (`&&`, `||`, `|`, `;`, newlines); the first word of each command (the program), flags with their `=` values, env assignments, redirections and words holding `$` or a backtick are dropped. A runner target runs from its manifest's directory and a CI step from the repo root; `cd X` moves that base. A word with a path separator counts by its static prefix (the segments before the first `*?[{`) when that is a directory of the repo's `wm_files` paths, or, with no glob, the parent of the indexed file it names; a bare word counts only when it is such a directory, and a glob with no separator (`*.js`, `'v[0-9]*'`, the `[` builtin) counts nothing. A path that leaves the repo root counts nothing, and when the commands after `cd X` name no directory, `X` itself is covered. So `node --test tests/unit/*.test.mjs` covers `tests/unit`, `eslint src lib` covers `src` and `lib`, `cd pkg && npm test` covers `pkg`, and `tsc --noEmit` covers nothing. npm script chains (`npm run lint`) and tool config files (eslint `files`, tsconfig `include`) are not followed. A manifest's covers are recomputed when the manifest is re-parsed.

**Bundles** (GH 2284; schema v56). A generated bundle stays out of `wm_files` and symbol scope, but a tracked `.js`, `.mjs` or `.cjs` file under generated output with a tracked sibling `<bundle>.map` gets a `module` row of its own (its `body_hash` is `<map content_md5>:<EXTRACTOR_VERSION>`, so the map is read again only when it or the version changes) and one `bundles` edge to each source the map's ECMA-426 `sources` array lists, resolved against the map's directory plus `sourceRoot` to a repo-relative path and `'exact'` to that file's `module` row. A source under `node_modules`, outside the repo or behind a non-`file:` URL gets no edge, and a map with no in-repo source, an unreadable map or a removed map drops the bundle's row. `dashboard/dist/server.mjs` (built with `--sourcemap`) and the trajectory-server's bundles carry such maps, so the card of a trajectory-server source names the bundles to rebuild after editing it.

`signature` is the definition up to its body, `doc` the full comment block directly above it plus any `description:` string inside the definition, capped at 1000 characters, `body_hash` an md5 of the body with comments stripped, and `terms` the split-name words FTS indexes (`persistScan` → `persist scan`), plus the kind and file name. Calls resolve, in order, to a definition in the same file, the definition an import names, a function in a sourced shell file, or the one non-test definition of that name (4+ characters); the first three set `resolution='exact'`, the last `'name'`, and a call that matches none stays `'unresolved'` with `dst_id` NULL. `hint` keeps the edge's import specifier. After indexing, the edges whose `dst_name` names a symbol this scan inserted and that are not `'exact'` or lost their target resolve again, and so does every edge whose target this scan deleted; table edges naming an inserted symbol resolve again even when `'exact'`, and so do non-exact table edges whose table now has a single definition outside tests and fixtures. A caller of a function added later in another file, moved to another file or re-created under a new kind ends as a fresh full index would leave it, without being re-parsed. Table edges bind `'exact'` to a `sql_table` when the table has exactly one definition outside tests and fixtures, and otherwise resolve by name, preferring a real `.sql` definition, then any real one, then a non-test `.sql` file.

Freshness is keyed by `symbols_md5`, stamped `<content_md5>:<EXTRACTOR_VERSION>` (`EXTRACTOR_VERSION` in `symbol-index.ts`): a file is re-parsed only when its stamp differs from that value, so bumping the version after an extractor fix re-parses every file once, with no migration. A file whose read or extraction throws loses its symbols and is stamped `<content_md5>:<EXTRACTOR_VERSION>:failed`, so it is not re-parsed until its content or the version changes; `indexRepoSymbols` counts it in `files_failed` and names it in `failed_paths` (`{path, error}`, at most 20, each error clipped to 200 characters). The `wm_files_symbols_indexed` data contract (`trajectory_doctor`, warn) counts the in-symbol-scope `wm_files` rows whose `symbols_md5` is not `<content_md5>:<EXTRACTOR_VERSION>` and samples up to 20 of them by path, each marked `failed`, `unstamped` (NULL: the repo's symbol pass threw before stamping, logged as `symbol_index_error`) or `stale` (stamped at another version) (GH 1858). Re-parsing upserts the file's symbols by `(kind, qualified_name)`, so an unchanged symbol keeps its id and edges into it from other files stay attached; symbols gone from the file are deleted (their inbound edges' `dst_id` goes NULL and `resolution` back to `'unresolved'`), and the file's own edges are rebuilt and resolved. A file dropped from the tree takes its symbols and their edges with it. Generated output (see **Generated output** under Population) and lockfiles are not indexed, and neither are untracked files. The grammars load on the first scan that has a file to parse, never at server start. After the server connects it spawns a detached `scripts/maintenance/run-scan.mjs <CLAUDE_PROJECT_DIR>` catch-up scan (`src/startup-catchup.ts`; the scan lock serialises it with any other scan) and logs one `startup_catchup` line; it is skipped for a `:memory:` DB, `TMB_SKIP_AUTO_RESCAN=1`, a `node:test` process, no `CLAUDE_PROJECT_DIR` or a missing script.

**Concepts (L2, v45, GH 1680).** The concept layer of [ADR 0002](./adr/0002-world-model-concept-layer.md): agent-written flows, subsystems and invariants, each an ordered list of steps. A step anchors the ADR 0001 key (`repo`, `path`, `kind`, `qualified_name`; `kind` `''` anchors the whole file), keeps the anchor's hash at write time (`body_hash`, or the file's `content_md5`), and names its `handoff` to the next step (`calls`, `sources`, `runs`, `hook_fires`; NULL on the last). The symbol is resolved from the key at read time. Claims are checks over the index, stored with their `last_result`. Each takes `args` in one shared schema (`CLAIM_ARGS_SCHEMA` in `concepts.ts`, used by `world_model_concept_upsert` and `task_update_status`'s `report.concepts`):

| Claim | `args` | Passes when |
|---|---|---|
| `exists` | `{path, qualified_name}` | the symbol is indexed |
| `calls` | `{from: {path, qualified_name}, to: {path, qualified_name}}` | an edge runs from `from` to `to` |
| `only_writers_of` | `{table, writers: [path]}` | no file outside `writers` has a `writes_table` edge to `table` |
| `tested_by` | `{path, qualified_name, test_path}` | a symbol in `test_path` references the symbol |

Args are checked before the index is: a field of the wrong shape fails by name with its expected shape (`fail: from must be {path, qualified_name}`, `fail: test_path must be a string`), not as a missing symbol (GH 1840).

- **Write.** `world_model_concept_upsert` replaces a concept by `(repo, name)` in one transaction and keeps its id. Every step must anchor a current symbol or file and every claim must pass, or it errors and writes nothing. `verified_sha` is `git rev-parse HEAD`.
- **Refresh.** At the end of every scan, after symbol indexing, each live concept is re-checked: a moved hash makes its step `suspect`, a missing anchor `broken`, a failing claim breaks the concept. The concept takes its worst step's trust, and `status_reason` names each step or claim that is off (`step 3 isTestPath: changed since verification`). A re-upsert restores `verified`; `retired` concepts are skipped.
- **Lane.** Paths under `test/`, `tests/`, `fixtures/` or `__fixtures__/` (and `*.test.*` files) never anchor a step or join a derived chain.

## Population

`scan_run` walks the session dir for git repos, derives the unique directory set from each repo's tracked file list, then writes `wm_directories` and `wm_files` rows via `src/graph.ts`, all in one transaction. Its walker, `src/tools/scan-walk.ts`, supplies each tracked file's `size_bytes`, `content_md5` and `last_commit_sha`.

**Repos.** The session dir itself is always scanned. A repo below it is skipped, with one `scan_skipped` audit row per path and reason, when its path below the session dir has a dot-prefixed segment (`dot_dir`, e.g. `.tmp-*/proj`), an enclosing repo ignores it (`git_ignored`), it is a linked worktree of another repo (`linked_worktree`, made by `git worktree add`), or it has no commit (`no_commits`). A linked worktree indexed by an earlier scan is dropped like any other repo the scan does not find. A `repos` row under the session dir that the scan does not find is deleted, unless a task or another row still references it; such a row is kept and listed in the result's `repos_stale_kept` (`name`, `path`, `reason`: `task_referenced` or `row_referenced`).

**Generated output** (GH 1835). Tracked files that are build output are skipped before anything is written: a path with a `dist/`, `build/`, `node_modules/` or `vendor/` segment, or ending in `.map` or `.min.js` (`isGeneratedPath` in `src/parsing/extract.ts`). They get no `wm_files` row, no directory, no purpose and no README drift, and rows an earlier scan stored for them are pruned like any vanished path. Lockfiles (`package-lock.json`, `*.lock`, `*.lockb`) are not generated output: they keep their `wm_files` rows and are only left out of the symbol index.

**Files.** For each tracked file the scan looks up its `wm_files` row:

- absent, or `content_md5` differs → read at most the first 4 KB, run `extractPurpose` (`src/file-purpose.ts`), upsert the row with `updated_at` = scan time;
- `content_md5` equal → leave the row untouched (purpose and `updated_at` preserved), except that a `none` row is re-extracted and rewritten only when a purpose now comes out;
- existing row has `purpose_source='swe'` and the md5 differs → refresh md5/size/sha/`updated_at`, keep `purpose` and `purpose_source`.

After symbol indexing, `refreshSymbolPurposes` (`src/symbol-purpose.ts`) rewrites each `none` or `symbols` row whose symbol-derived purpose changed, so a file's `symbols` purpose follows its definitions. A file that gains a header moves to `comment` / `jsdoc` on the next scan through the `content_md5` re-extract in `planFiles` (`src/tools/scan.ts`). Directory structural summaries are built before this pass, so they pick up a new `symbols` purpose one scan later.

File rows whose path is gone from the repo's scan are deleted, and so are all rows of a repo that left the workspace; `repo_rename` re-keys them with the directory rows. The 4 KB head is the only file read; file bodies are never stored. The table stores purposes raw; because they come from file contents, every read path wraps them in `<untrusted-content source="file-purpose">` delimiters (the same `frameUntrusted` framing README summaries get), so agents treat them as data.

**Extraction rules** (pure, by extension or file name; whitespace collapsed, comment markers stripped, cut at the first sentence end or 200 characters):

| File | Purpose from | `purpose_source` |
|---|---|---|
| `.py` | module docstring (after any shebang / comment lines) | `docstring` |
| `.ts`, `.tsx`, `.js`, `.mjs` | a JSDoc block with `@file` / `@fileoverview`, else the first comment block | `jsdoc` / `comment` |
| `.ts`, `.tsx`, `.js`, `.mjs`, `.sh`, `.pl`, `.sql` | first comment block (`//`, `/* */`, `#`, `--`) after any shebang; license / SPDX / copyright and linter-directive lines are skipped | `comment` |
| `.md` | frontmatter `description:`, else the first H1 plus the first sentence of the paragraph under it | `frontmatter` / `heading` |
| `package.json`, `plugin.json`, `marketplace.json` | top-level `description` | `manifest` |
| `.json`, `.yml`, `.yaml` with no header | `name: description`, else `name`, else `schema <$schema>`, else `keys: a, b, c` (`items with keys:` for an array of objects, `items:` for an array of strings) | `structural` |
| `.txt`, any file under `changelog.d/` | `<directory role>: <file stem>` (`changelog fragment`, `<owner> fixture`, `<parent> text`) | `structural` |
| `.md` with no frontmatter or heading | its first non-empty line, inline markup stripped | `structural` |
| a code file with no header (post-pass) | `exports: Name (kind), …` plus the first sentence of the module doc or main export's doc; else `defines: …` of the top-level definitions (`functions: …` for shell); a test file gives `tests for <subject>: <first describe/test titles>` | `symbols` |

Fallback lists end in `+N more` when they would pass 200 characters. A NUL byte in the head (binary), an empty head, or no match yields `{purpose: '', source: 'none'}`.

**Directories.** For each directory the scan checks disk for `<dir>/README.md` (or `readme.md` / `README.rst`); if present, content (truncated to ~1 KB) becomes the dir's `summary` with `summary_source='readme'`. Otherwise the scanner synthesizes a deterministic **structural** summary (`summary_source='structural'`): `<dir>/ — N files; <untrusted-content source="file-purpose"> <name>: <purpose>; … </untrusted-content>` with up to 5 file purposes sorted by name, framed once on a single line so the depth-2 first-line trim keeps the whole frame, or the immediate file names when no file has a purpose, then `subdirs: …` — so every node is non-empty and reachable by `world_model_search`, never `NULL`.

**README drift** (v43, GH 1680). A README summary can go stale while the code under it moves on. For each directory whose README is tracked, the scan runs `git -C <root> …` (via `spawnSync`, bounded by a timeout) and writes three columns:

| Column | Value |
|---|---|
| `summary_sha` | the last commit that touched the README (`git log -1 -- <dir>/<readme>`) |
| `commits_behind` | the distinct commits since `summary_sha` that change a file the README references other than by adding it (GH 1833): `git log --diff-filter=a --format=%H <summary_sha>..HEAD -- <referenced files>`. Adds, and edits or deletes of files the README does not name, never count, so a directory that grows by design (`changelog.d/`) stays current. A README with no file refs reads 0 |
| `dead_refs` | a JSON array of repo-relative paths the README names that are missing on disk; `'[]'` when there are none |

The referenced files are the README's candidates (below) that resolve to a file tracked today, deleted by git or renamed away, relative to the README's directory or else to the repo root, without the README itself, passed as `:(literal)` pathspecs and capped at 200; with none, that `git log` is skipped. A referenced directory (`changelog.d/`) resolves to no file, so it never counts toward `commits_behind`; it still feeds `dead_refs`.

Dead references are found in the full README (not the 1 KB summary clip), with any `<untrusted-content …>` framing stripped first. The candidates are markdown link targets and backtick spans that look like paths. A backtick path is checked only when it has no `/` (and has a file extension) or its first segment is a tracked directory, at the repo root or under the README's directory. Anything starting with `..`, under `dist/`, or containing `${`, `<` or `*` is skipped. A candidate is dead when it exists neither relative to the README's directory nor relative to the repo root, and it is a markdown link or git deleted it. A ref with a `/` counts as deleted only when it matches a deleted path exactly, relative to the repo root or the README's directory; a bare filename counts only when a deleted file has that basename and no file tracked today does (a deleted `.claude/agents/swe.md` does not flag `swe.md` while `agents/swe.md` exists). The deleted set (its `D` rows) and the renamed-away set (its `R` rows, used only for `commits_behind`) come from one `git log --diff-filter=DR --name-status --format=` and the tracked files and basenames from one `git ls-files`, each per repo per scan. Git runs outside the write transaction, so it never holds the DB lock.

All three columns stay `NULL` for structural directories and for roots that are not git repos. Any git failure leaves them `NULL` and never fails the scan.

Re-running `scan_run` is summary-preserving via upsert — existing rows update structural fields and refresh README-derived summaries.

`scan_run` also has one SQLite side effect outside the graph: a resource-discovery pass (#124/#846) reconciles locally-present capabilities — project-local skills, enabled plugins, configured MCP servers — into the trajectory DB's `cheatcodes` table (`origin='installed'`, `source_url='scan_discovered'`). That write lands in the workflow tables; the world model holds only the directory, file, symbol and concept layers. See [`CHEATCODES.md`](./CHEATCODES.md).

## Concurrency

The world model shares the trajectory DB's handle and its WAL-mode, busy-timeout concurrency: a scan writes inside one immediate transaction, so readers in other sessions see the old map or the new one, never half of each. There is no separate lock to contend for.

## Querying

`world_model_get(repo, path, depth)` returns a directory tree. Every directory node carries `summary_sha`, `commits_behind`, `dead_refs` (an array) and `trust`. A recursive CTE over `parent_path` selects the directory and its descendants down to `depth`; the tree is then built in TypeScript by linking each row to its parent. Default `depth=2` (root + immediate children); `depth=null` returns the full subtree.

- **Covered by** (GH 2326): a directory node gains `covered_by: [{runner, path, line, command}]`, the `runner` symbols whose `covers` edge names that directory or one of its ancestors, nearest first, each once, at most 10, plus `covered_by_truncated: true` when cut. `runner` is the runner's name, `path` its manifest or CI file, `command` its signature framed as `runner-command` untrusted content. A directory no runner covers carries no `covered_by` field.
- **Zoom-in** (`path` names a directory): the returned node also carries `files: [{path, purpose, purpose_source, content_md5}]` — that directory's own files, sorted by path, `path` repo-relative, each non-empty `purpose` framed as `file-purpose` untrusted content. Children never carry file arrays.
- **Root call** (`path` omitted or `''`): the response adds `coverage: {files, with_purpose, by_source: {<purpose_source>: n}}` for the repo, so bro sees how much of the repo has a purpose. The default depth-2 tree carries no file arrays, so the cold-start call stays directory-sized.

**Checkout lag** (GH 1966). The world model indexes the repo's checkout, which trails `origin/<target>` as lanes merge, so a file or line range can be missing or shifted without the index being wrong. When the checkout is behind, `world_model_get`, `world_model_search`, `world_model_symbol` and `task_brief`'s scope section add `checkout_behind_upstream: N` (`git rev-list --count HEAD..origin/<target>`) and `upstream: 'origin/<target>'`, the target being `repos.target_branch` or the repo's default branch. The count is against the last fetch; the server never fetches. Both fields are absent when the checkout is current, the target has no `origin` ref, or git fails.

`world_model_search(query, mode='hybrid')` searches directories by `path` + `summary`, files by `path` + `purpose`, and symbols by split name, signature and doc. Each result carries `kind: 'dir'` (with `summary`, `summary_source`, `file_count`), `kind: 'file'` (with `dir`, a framed `purpose`, `purpose_source`) or `kind: 'symbol'` (with `id`, `qualified_name`, `symbol_kind`, `path`, `line_start`, `line_end`, and `signature` and `doc` framed as `symbol-signature` / `symbol-doc` untrusted content, plus `stale`) and a `score`, capped at `k` results overall (default 5, max 100). `total_matched` counts the distinct ranked hits before that cut, and `truncated: true` marks a cut list or a keyword pool that came back full, so more rows may exist. Directory results also carry `summary_sha`, `commits_behind`, `dead_refs` and `trust`.

`world_model_symbol(id)` (or `qualified_name` with optional `repo` and `path`) returns one symbol's card: `{symbol, callers, callees, imports, reads_table, writes_table, reads_config, tests, bundled_by}`. Each list holds up to 50 refs `{id, qualified_name, kind, repo, path, line_start}` plus `total`, the full count before that 50-ref cap, and a `truncated` flag. Callers are the non-test symbols that call, instantiate, run or source it; `tests` are the test-file symbols with any edge into it; for a `sql_table`, `reads_table` and `writes_table` list the readers and writers; `bundled_by` lists the bundle `module` rows with a `bundles` edge into the symbol's file, whatever the symbol; `reads_config` lists the `plugin_config` keys it reads as `{key, line}` refs. When any edge of the symbol other than `reads_config` resolved by name or not at all, the card adds `note: "found by name; not all callers"`. `world_model_symbol(config_key='x')` returns `{config_key, readers}` instead, each reader `{qualified_name, kind, repo, path, line}`. Several definitions with the same name return `warning: 'ambiguous'` and their refs instead of a card.

`symbol.stale` (and `stale` on each symbol search hit) is `true` when the file on disk differs from the index: its md5 differs from `content_md5`, its `symbols_md5` stamp lags, or the file is gone. A rescan clears it. `impact: true` (2 hops) or `impact: 1`–`5` adds `impact {depth, levels: [{depth, refs}], tests, truncated}`: inbound callers walked breadth-first over the call edges, grouped by hop, each symbol listed once so cycles end; a test-file caller goes to `tests` and is not walked past; the walk stops at 200 refs with `truncated: true`. `source: true` adds `source {start_line, end_line, text, truncated}`: the body read from the repo root on disk, capped at 200 lines, `text` framed as `symbol-source` untrusted content; a path resolving outside the repo root, or a missing file, returns `source: null` with a `source_reason`. Without `impact` or `source` the card has no such key.

`world_model_concepts(query, repo?)` returns `{available, concepts, derived}`. `concepts` are bm25 hits over name (10), body (4) and the step descriptions (2), every word first, then, when that finds fewer than 3, any concept that matches a majority of the query words (`floor(n/2)+1`, each word counted by its own FTS match); each is `{id, name, body, step_count, trust: {verified, suspect, broken}, rank}`. When none match, `derived` is a chain read off the index, `{label: 'derived, unverified', steps}`. Its seed comes from the same hybrid ranking `world_model_search` uses: the first of the top 5 file and symbol hits that sits outside the test lane and whose own terms (a symbol's name, signature and doc; a file's path and purpose) cover a majority of the query words. A symbol hit seeds itself; a file hit seeds its symbol that matches the most query words, then has the most outgoing derived edges, then comes first. With no such hit, or no graph, `derived` is null. The seed starts a breadth-first walk over `exact` `calls`, `sources` and `runs` edges in source-line order, to depth 4 and at most 8 steps, skipping the test lane and leaf helpers (a callee with 5 or more distinct exact callers and no outgoing derived edge, such as an `error_json`). Each step's description is its symbol's doc, else its signature, framed as `symbol-doc` untrusted content. `available` is false until the repo has been scanned.

`world_model_concept_get(id)` returns `{id, name, body, status, status_reason, updated_at, steps}`, steps in ordinal order, each `{ordinal, description, trust, trust_reason, handoff, symbol}`. `symbol` is `{id, repo, path, kind, qualified_name, signature, doc, line_start, line_end}` resolved now, or `null` with trust `broken` when the anchor is gone. A file anchor resolves to `{id: null, repo, path, kind: 'file', qualified_name: <path>, signature: null, doc: null, line_start: null, line_end: null}` and keeps its stored trust.

`trust` reads the drift columns: `'current'` when `commits_behind` is 0 and there are no dead refs, `'drifting(n)'` when `commits_behind` is n > 0, with `'dead_refs(k)'` appended after `, ` when the README names k dead paths (`'dead_refs(k)'` alone on an otherwise current README), and `null` for structural directories and non-git roots.

**Sentence queries.** Keyword search first requires every query term (an FTS5 AND). When that matches no row, it reruns as an OR of the terms minus a small English stopword list, still ranked by bm25, so a question like "where does the invoice code live" finds the invoice directory. Symbol search falls back to OR when the AND form finds fewer than 3 symbols. The response's `match` key says which ran: `'all_terms'` or `'any_term'`.

**Keyword ranking.** Symbol bm25 weights a name match (10) above a doc (4) or signature (3) match; `module` rows are left to the file hits. Results are then ranked per file path: a path scores `w / (10 + rank)` for the rank of its first symbol hit plus the same for its file-hit rank, so a file found both ways rises, with `w = 0.5` for test files and `changelog.d/` fragments and file hits under `dist/` or ending `.map` dropped. A path's first hit takes the path score and each later hit of the same path a falling share of it; directories score `w × d / (10 + rank)` by their own rank, with `w = 0.5` for a directory under a test, fixture or `changelog.d/` path (as a file inside it would weigh) and the dir weight `d = 0.5` whenever the keyword symbol search returned a hit, else 1, so source symbols lead and a query that matches only directories keeps their order. Weighted hits stay in the results, lower down (GH 1967).

| Mode | Behavior |
|---|---|
| `keyword` | FTS5 bm25 over path + summary/purpose and symbol names (all terms, else any non-stopword term) plus case-insensitive substring hits, ranked per path as above |
| `semantic` | Cosine over bge-small embeddings of `path: summary` / `path: purpose`, each score times the hit's test/fixture/changelog weight `w` (no dir weight). Vectors come from the q8 (quantized) bge-small model and are stored under `model_id` `Xenova/bge-small-en-v1.5@q8`; rows stored under another id are re-embedded by the backfill |
| `hybrid` (default) | Reciprocal rank fusion (k = 60) of the keyword lists (directories; files and symbols) and the semantic lists for directories and files, each list adding `w × d / (60 + rank + 1)` to a hit with the keyword weights above (`d` for directories only), so a directory found by both keyword and semantic search ranks below a source symbol found once. Symbols have no embeddings |

Embeddings are computed on demand: each `semantic` or `hybrid` search embeds up to 50 missing rows per table first and, when more are missing, starts a background backfill. When the embedding model is unavailable, `semantic` and `hybrid` return the keyword hits with `warning: 'semantic_unavailable'`.

### Measuring WM use

Every call to the six world-model tools, error results included, writes one `wm_tool_called` audit row (GH 1836). `content_json` carries `tool`, `agent`, `task_id`, `args`, `result_count`, `empty`, `error`, `warning`, `match`, `derived` and `latency_ms`. `task_id` is the task of the single open `agent_runs` row for the caller's role, else null, and the row is then filed on the system issue `-1`. Logging is fail-open: a failed insert never changes the tool's result.

```sql
-- calls and empty-result rate per tool
SELECT json_extract(content_json, '$.tool') AS tool,
       COUNT(*) AS calls,
       AVG(json_extract(content_json, '$.empty')) AS empty_rate
  FROM audit WHERE event_type = 'wm_tool_called'
 GROUP BY tool ORDER BY calls DESC;

-- calls per task (NULL: no single open run matched the caller)
SELECT json_extract(content_json, '$.task_id') AS task_id, COUNT(*) AS calls
  FROM audit WHERE event_type = 'wm_tool_called'
 GROUP BY task_id ORDER BY calls DESC;
```

## When bro reaches for it

| Situation | Bro's move |
|---|---|
| Cold session, code-touching ask | `world_model_get(depth=2)` |
| "Where in this codebase does X live" | `world_model_search(query='X', mode='hybrid')` |
| Zoom into one part | `world_model_get(path='src/api', depth=1)` — includes each file's purpose |
| "Who calls X / what does X touch" | `world_model_symbol(id)` from a search hit, or `world_model_symbol(qualified_name='X')` |
| "How does flow X work" | `world_model_concepts(query='X')`, then `world_model_concept_get(id)` |
| File-level detail (rare) | direct Read with explicit paths |

## Consumers

`task_brief(task_id)` (a composite in `tools/composites.ts`) is the world model's main programmatic consumer: it parses a task spec's `## Files`, resolves those directories against the world model, and bundles that with the task row + the issue's discussion thread into one read. Output is concise by default for every caller and section (GH 1958): `scope_world_model` holds each dir and its child paths without summaries, and `task_discussions` keeps this task's decision and intent rows plus the issue's newest decision and intent, reducing other rows to `id`, `kind` and `author`. `response_format: 'detailed'` returns the summaries and full rows, and concise output names that option in `response_format_hint` whenever it trimmed something. Its `section` argument splits the read (GH 1743): swe gets `core` by default and loads `scope` (the world-model part), `verification` and `history` on demand; every other caller gets `all`. swe receives this brief instead of orchestrating `task_get` + `world_model_get` + `discussion_search` itself — the Architect→SWE handoff. Decision record: issue #300.

The core section also carries two read-time world-model blocks, both built in `brief-locations.ts`. `locations` (GH 1906) resolves the paths and identifiers the spec names in backticks against the L1 symbol index, with line ranges, callers and callees, within 6000 chars. `concepts` (GH 2321, `briefConcepts`) lists the L2 concepts anchored to the task: a concept matches when one of its steps has a path under the task's `files[]`, a path `locations.files` names, or the path and `qualified_name` of a `locations.symbols` entry; claims are not anchors. It is `{items, truncated}`, each item `{id, name, kind, status, status_reason, flagged, body, anchors}`, where `anchors` holds the matched steps (`{ordinal, path, qualified_name, trust}`, at most 5) and `body` is the concept body cut to 500 chars and framed as `concept-body` untrusted content. `retired` concepts never appear; `verified` ones come first, then `suspect` and `broken` with `flagged: true`, each group ordered by matched-anchor count, then id. At most 5 items and 3000 chars of JSON; items drop from the tail and `truncated` turns true. `concepts` is null when `locations` is (no world model for the repo).

## Design history

The world model has had four substrates, each replacing the last:

- **`file_registry` (v6)** — one row per file (md5 + an LLM summary). Wrong granularity (a file summary says what a file *contains*, not what part of the system it *serves*), drift-sensitive (a one-line edit cleared the summary), and token-heavy. Dropped in v7.
- **SQLite `directories` table (v7)** — the dir-level model as a stepping stone inside the existing trajectory DB. It validated that a README-first directory map is the right cold-start surface: ~10× fewer rows than per-file, and directory summaries change monthly (a part's role) rather than per-commit (a file's contents). Dropped in v8.
- **Embedded graph DB (v8–v41)** — the same dir-level model on a separate graph engine, chosen for the import/call relations to follow. Its single-writer lock, native-binding install and exit-time crashes cost more than the graph queries it never ran. Schema v8 dropped the SQLite `directories` tables.
- **`wm_` tables (v42, current)** — the directory and file layers back in the trajectory DB, with FTS5, embeddings and recursive-CTE tree walks. The old graph files are not migrated; `/scan` rebuilds the map. v43 added the README drift columns (`summary_sha`, `commits_behind`, `dead_refs`) to `wm_directories` in place; they stay `NULL` until the next scan. v44 added the L1 symbol layer (`wm_symbols`, `wm_edges`, `wm_symbols_fts`) and `wm_files.symbols_md5`, which stays `NULL` until the next scan parses the file. v45 added the L2 concept layer (`wm_concepts`, `wm_concept_steps`, `wm_concept_claims`, `wm_concepts_fts`), `wm_symbols.run_order` with the `hook` kind, and `wm_edges.hint`; it clears `symbols_md5`, so the next scan re-parses every file.

File rows bring per-file state back with the two `file_registry` faults fixed: a purpose is one deterministic line (what the file is for, not what it contains) at zero token cost, and an edit only re-extracts when the content hash changes while an swe-written purpose survives it.
