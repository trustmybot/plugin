### Fixed
- **`task_brief` now tells swe which worktree to work in** (GH 2177): the swe prompt says to target the brief's `worktree_path`, but the brief never returned one, so swe had to go looking for its worktree. The `core` section now returns it: the task's recorded worktree when it has one, else the path `task_provision` creates, and null when the task's repo path cannot be resolved.
