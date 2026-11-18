### Changed
- **The docs state what happens while the health check is not green, and how TMB is upgraded, backed up and removed** (GH 3260): reads and the health check stay allowed, a DB newer than the plugin denies at session start, backups are fresh per attempt with the newest three kept, and one cleanup command removes what TMB added. Each is marked planned where the code does not do it yet.
