### Changed
- **The dashboard smoke test runs on node:test** (GH 1692): `dashboard/test/smoke.sh` is now `dashboard/test/smoke.test.mjs`, run with `node --test dashboard/test/smoke.test.mjs` after `bun run build`. It seeds the same temp DB, checks the same 24 paths and the unchanged DB file, then the 4 world-model checks on a v41 DB, one subtest per path, without bash or curl.
