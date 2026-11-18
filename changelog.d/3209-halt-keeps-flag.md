### Fixed
- **The HALT fallback command keeps `--experimental-sqlite`** (GH 3209): the server-down HALT line gives `bro-sqlite-readonly` as `node --experimental-sqlite …/cli.js bro-sqlite-readonly`, matching tmb_recovery and its allowed-tools.
