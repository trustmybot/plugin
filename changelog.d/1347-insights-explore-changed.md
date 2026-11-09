### Changed
- **Insights polish** (GH 1347): bro's token histogram counts sessions, not runs. The slowest verification commands list ranks commands with at least 20 runs by p95 first, then the rest by their slowest run, so a rare slow command is no longer hidden.
