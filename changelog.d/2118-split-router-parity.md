### Changed
- **Faster full test suite** (GH 2118): router decision parity now runs as one test file per Bash gate, each building only its own gate's sandbox, and worktree-lifecycle parity runs as 8 shards instead of 3, so `node --test` spreads both across processes instead of waiting on one long file.
