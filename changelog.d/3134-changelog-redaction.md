### Fixed
- **The changelog lint accepts redaction-only edits to released entries** (GH 3134): a branch may shorten a released `CHANGELOG.md` entry when the edit adds no more lines than it removes and touches no heading; every other direct `CHANGELOG.md` edit still fails.
