### Fixed
- **`bro_atomic_close` no longer reports `base_moved` for every stacked task** (GH 2384): a task cut from a live sibling branch now closes with `base_moved: false`; the flag is true only when the task's recorded base is missing, or is not a descendant of the merge-base with the PR target (the target moved past it, or the two diverged).
