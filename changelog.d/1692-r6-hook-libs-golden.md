### Changed
- The hook-libs differential test now checks the TypeScript hook libs, through node:sqlite and through the `sqlite3` CLI, against `tests/fixtures/hook-libs/expected.jsonl`, the outcomes of the shell libs frozen once, instead of running a bash harness over `scripts/hooks/lib/*.sh` each time (GH 1692); every assertion is kept, and `tests/fixtures/hook-libs/divergences.jsonl` is gone.
