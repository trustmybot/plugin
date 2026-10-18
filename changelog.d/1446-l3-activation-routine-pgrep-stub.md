### Fixed
- The L3 `db-path-rule` and `hook-content-preservation` tests now run `activation-routine.sh` under a `pgrep` stub that reports a live trajectory server, so they pass on CI runners with no server process instead of failing on the leaked HALT text (GH 1446).
