### Fixed
- **The recovery skill names the node:sqlite read fallback** (GH 3209): `tmb_recovery` now calls `bro-sqlite-readonly` the read-only node:sqlite fallback, not the retired sqlite3 one.
