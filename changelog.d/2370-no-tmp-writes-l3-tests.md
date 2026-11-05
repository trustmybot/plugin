### Fixed
- **The no-tmp-writes lint passes on dev again** (GH 2370): three L3 tests ported to node:test plant a literal `/tmp` path on purpose to exercise the `/tmp` guards, and the lint flagged them. `tests/l1-lint/no-tmp-writes.allowlist` now lists those three files, and its header admits tests that exercise a `/tmp` guard by design.
