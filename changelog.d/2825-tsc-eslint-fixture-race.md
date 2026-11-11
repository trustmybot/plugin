### Fixed
- **tsc-noemit no longer races eslint.test's temp fixtures** (GH 2825): the MCP server tsconfig excludes `src/eslint-fixture-*`, and each eslint fixture dir carries its own tsconfig so typescript-eslint still type-checks it; the L1 type-check no longer fails when the eslint test deletes a fixture mid-run.
