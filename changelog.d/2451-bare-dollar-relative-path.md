### Fixed
- **A literal `$` in a relative write path no longer hides the write from the containment guard** (GH 2451): a `$` that starts no expansion, such as a trailing `a$` or the literal `$` in `"$'$HOME'"`, is kept literal and the path resolves against the effective directory, so the guard judges it instead of skipping an unresolved relative word.
