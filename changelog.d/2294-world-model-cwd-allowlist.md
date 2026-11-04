### Fixed
- **The no-cwd-reads lint passes again** (GH 2294): the world-model default repo added in GH 1968 reads the server's start dir only when the tool caller names no repo. The lint now allowlists that read as a fallback, so `tests/run-all.sh` is green on dev again.
