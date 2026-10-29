### Fixed
- **Scorer tests stop when fixture setup fails** (GH 2160): failed scratch allocation, Git setup or database initialization can no longer send fixture writes and Git commands into the caller's checkout. Every fixture stays under one temporary root that the test removes on exit.
