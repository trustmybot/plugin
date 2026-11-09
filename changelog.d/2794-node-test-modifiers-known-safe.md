### Fixed
- **node:test modifiers pass the floating-promise lint** (GH 2794): `describe.skip()`, `it.only()`, `test.todo()`, `suite.skip()` and the other `skip`/`only`/`todo` modifiers from `node:test` now count as known-safe calls for `@typescript-eslint/no-floating-promises`. Same-named methods from any other source are still flagged.
