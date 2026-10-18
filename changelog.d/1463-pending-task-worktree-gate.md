### Fixed
- **A planned task can be dispatched** (GH 1463): `task_reopen` now accepts a `pending` task and creates its worktree, and the swe spawn gate denies a pending task whose branch has no linked worktree, naming the `task_reopen` call that creates it, so swe no longer starts with nowhere to work.
