### Fixed
- **`build:tsc` now copies the schema into `dist/`** (GH 2854): gate runs and CI that build with `bun run build:tsc` used to test whatever `dist/schema*.sql` the last full build left; `build:tsc` now copies `src/schema*.sql` itself, and an L1 lint keeps it that way.
