### Fixed
- **The hooks-parity suite passes again for the swe-boundary git stash cases** (GH 2973): the 8 stash corpus cases added in GH 2786 had recordings only for the dedicated swe-boundary suite, so hooks-parity failed with "no recording" for each. Their hooks-parity recordings are now in place: `git stash list` and `git stash show` are allowed, and every other stash form is denied.
