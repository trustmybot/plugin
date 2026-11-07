### Fixed
- **The hooks-parity tests pass again** (GH 2442): the containment-guard parity case for a write target built by a command substitution used `$(mktemp)`, which the guard now resolves to the temp dir and allows (GH 1912), so its frozen deny no longer matched. The case now uses `$(date +%s)`, which the guard still cannot judge, and its golden entry was re-recorded from the shell gate.
