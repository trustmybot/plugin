### Fixed
- **The purpose-header lint now checks dashboard source** (GH 2707): `tests/l1-lint/purpose-header.test.mjs` scoped the dashboard as `dashboard/src/`, a directory that does not exist, so new dashboard files were never checked. It now covers `dashboard/web/` and `dashboard/server/` (with `node_modules/` exempt), and `docs/contributing/FILE_HEADERS.md` names the real directories.
