### Fixed
- **Before/after comparison scratch files stay out of commits** (GH 2708): a test-comparison script left `.old.*` and `.new.*` output at the plugin repo root. `.gitignore` now ignores those root files, and the swe checklist says scratch scripts and comparison output go under `$TMPDIR`, outside the worktree.
