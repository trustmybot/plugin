# World Model

Bro is the architect of every project it works on. The world model is the stable, queryable mental picture bro reasons from — built by `scan_run`, kept fresh on read, queried on every cold start.

This page covers purpose, boundaries and the reasons behind the design. Tables and columns live in `mcp/trajectory-server/src/schema.sql`, behaviour in `mcp/trajectory-server/src/` (`graph.ts`, `parsing/`, `symbol-index.ts`, `concepts.ts`, `world-model/`, `tools/`), and the tool contracts in each tool's description. To find a piece of it, ask `world_model_search`.

## Substrate

The world model lives in the trajectory DB as its own `wm_` tables, beside the workflow audit but with no foreign key into it. It is a derived cache: every row can be rebuilt from git, so `/scan` can always start over.

| | World model (`wm_` tables) | Workflow tables |
|---|---|---|
| Content | The project's map: directories, files, symbols and concepts | Workflow audit: issues, tasks, discussions, validation, plugin metadata |
| Bro's use | "What does this project look like?" / "Where does X live?" / "Who calls X?" | "What did we decide?" / "What's open?" / "What did swe commit?" |

## Layers

- **Directories and files.** Each directory carries a summary: its README when it has one, else a structural summary built from its files. Each file carries a one-line purpose extracted from its header, or a structural fallback. An swe-written purpose outranks extraction. Purposes and summaries come from file contents, so every read path frames them as untrusted content.
- **Symbols (L1).** A tree-sitter index of each file's definitions and the edges between them: calls, imports, table reads and writes, hook order, runner coverage and bundle sources. It answers "where is X" and "who calls X" without re-reading code.
- **Concepts (L2).** Agent-written flows, subsystems and invariants, each an ordered list of steps anchored to symbols or files, plus claims checked against the index. Every scan re-checks them and marks a step whose code moved as suspect, or broken when its code is gone.

## Design rationale

- **Own index, exact references from LSP.** TMB builds its own index because no off-the-shelf indexer covered this repo's shell and SQL; codegraph served as a design reference only, never a dependency. The index resolves many calls by name, so its answers say so, and an edit that needs exact references (a rename, a signature change) uses Claude Code's LSP tool.
- **Anchors are stable keys.** A concept step stores the symbol's key (repo, path, kind and qualified name), not a symbol id, and resolves it at read time. A re-parse never orphans a step; a rename breaks the anchor by design, so the concept is flagged for review rather than silently following the wrong code.
- **swe proposes, review admits.** The swe that built a flow proposes concepts in its completion report. A scan applies a proposal only once its task has a passing code-reviewer verdict and every anchor and claim checks out. Bro and consultants write concepts directly.
- **Indexed from git, never the working tree.** Each repo is indexed from git objects at its target commit (the fetched `origin/<target branch>`, else `HEAD`), so every session and worktree reads the same map. Reads, spawns and ref-moving commands bring the index forward incrementally; a full rebuild is the fallback.
- **One transaction per write.** A scan or reindex reads and parses first, then applies everything in one transaction, so a reader sees the old map or the new one, never a mix.

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

`task_brief` is the world model's main programmatic consumer: it resolves a task's scope against the world model and bundles it with the task row and the issue's discussion thread, so swe receives one read instead of orchestrating several. Output is concise by default; `response_format: 'detailed'` returns the full rows. The dashboard reads the same tables.
