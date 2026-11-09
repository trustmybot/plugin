### Fixed
- **L4 workflow flows no longer fail with `UNIQUE constraint failed: repos.name`** (GH 2801): under `bun test` the test server started a startup catch-up scan that registered the project repo before the harness did, so the harness's plain insert failed. The L3/L4 harness now sets `TMB_SKIP_AUTO_RESCAN=1` by default and registers the repo with an upsert.
