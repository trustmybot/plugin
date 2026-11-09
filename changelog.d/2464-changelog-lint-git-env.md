### Fixed
- **Changelog lint test fixtures stay isolated from your git config** (GH 2464): `changelogCurrent` now takes an `env` option for every git and fragments-lib spawn, and the L3 changelog-fragments test passes its `GIT_ENV`, so global and system git config no longer leak into the fixture repos.
