### Fixed
- **Files merged in from dev no longer count as task extras** (GH 3105): the scope check behind `review_handoff` and the `bro_atomic_close` scope gate now diffs from the target merge-base unless the recorded base is a live stacked branch ahead of it, so a task branch that merged a newer dev reports only its own paths and still fails on a real out-of-scope one.
