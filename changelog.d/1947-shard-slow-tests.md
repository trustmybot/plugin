### Changed
- **The trajectory-server suite's slowest test files run in parallel shards** (GH 1947): the hook parity, write-path analyzer, hook-libs, git-push-guard parity and world-model concept tests each split into `<name>.shard-<k>of<n>.test.ts` files that `node --test` runs side by side, instead of one long process per file. Every corpus row, locale and case still runs exactly once.
