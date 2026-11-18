### Fixed
- **The server-down HALT names the node:sqlite read fallback** (GH 3209): when the trajectory-server is not running, the bro HALT line now calls `bro-sqlite-readonly` the read-only node:sqlite fallback instead of naming the retired sqlite3 fallback.
