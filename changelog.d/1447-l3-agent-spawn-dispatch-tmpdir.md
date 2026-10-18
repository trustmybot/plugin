### Fixed
- The L3 agent-spawn-dispatch test no longer reassigns the runner's exported `TMPDIR` to a directory it then deletes; each case uses its own `WORK` directory, so the next `mktemp` no longer fails on GNU coreutils and the suite no longer aborts on CI (GH 1447).
