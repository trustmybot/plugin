### Fixed
- **A full scan no longer shows a half-written world model** (GH 2584): `/scan` wrote repos, directories and files, and each repo's symbols in separate transactions, so a read during a scan could see new files with old symbols and an old indexed commit. The whole scan, the indexed-commit stamp included, now commits in one transaction, so a reader sees the old index or the new one.
