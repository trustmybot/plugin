### Fixed
- **The issue-sync test isolation lint passes on `dev`** (GH 1993): the `issue_create` skip-reason tests built their spawn mock inside a helper, where the per-test lint could not see it. Each test now passes `_spawnFn` at the call site, and the helper has no default, so a test cannot reach the real remote CLI by omitting it.
