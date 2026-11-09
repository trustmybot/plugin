### Fixed
- **Every push to `dev` reruns the L1 tier** (GH 2651): `dev-build.yml` gains an `l1` job that runs `node --experimental-strip-types tests/run-all.ts --l1-only` after the same setup as `pr-check.yml`, so a PR whose green check predates a new L1 rule turns `dev` red once it merges instead of failing silently. The `stamp` job is unchanged and still publishes the dev build when L1 fails.
