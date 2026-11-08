### Added
- **World-model reads report how fresh the index is** (GH 2584): `world_model_get`, `world_model_search`, `world_model_symbol` and `task_brief` now return a `freshness` block with the indexed commit, the target ref and commit, whether the index is stale, the state of the newest reindex (running, idle or failed, with its mode, trigger and timing) and the count of concepts that need review. It is the same block the dashboard shows. A new `wm_freshness` table (schema v63) records it, and a reindex left `running` by a process that died is marked failed when the server starts.

### Fixed
- **A full scan no longer shows a half-written world model** (GH 2584): `/scan` wrote repos, directories and files, and each repo's symbols in separate transactions, so a read during a scan could see new files with old symbols and an old indexed commit. The whole scan, the indexed-commit stamp included, now commits in one transaction, so a reader sees the old index or the new one.
