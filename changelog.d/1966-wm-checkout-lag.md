### Changed
- **The world model says when its checkout is behind upstream** (GH 1966): `world_model_get`, `world_model_search`, `world_model_symbol` and `task_brief`'s scope section add `checkout_behind_upstream` and `upstream` when the indexed checkout trails `origin/<target>`, so files and line ranges from freshly merged lanes no longer read as world-model bugs.
