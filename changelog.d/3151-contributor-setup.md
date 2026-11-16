### Changed
- **One-command contributor setup with Bun declared** (GH 3151): `package.json` now declares Bun (`packageManager` and `engines.bun`, matching `.bun-version`), and `bun run setup` installs whichever dependencies are missing (the root and `dashboard/`) and builds the payload, so a fresh clone builds with one command. Worktree setup reuses the same install step (GH 3146).
