### Changed
- **Hooks no longer use or need the sqlite3 CLI** (GH 3150): every hook reads and writes the trajectory DB through Node's built-in `node:sqlite`, so a machine without `sqlite3` on PATH runs them the same as one with it. The `TMB_HOOKS_SQLITE=cli` switch is gone. On a Node without a usable `node:sqlite`, a hook DB read fails instead of falling back to the CLI.
