### Fixed
- **`cli.js integrate` and `feature-merge` no longer leave their temporary worktree behind** (GH 3110): when `git worktree add` failed partway, the half-checked-out dir stayed registered with git; now every failure ends with the worktree removed and its registration pruned, and a dir the filesystem refuses to delete is named on stderr.
