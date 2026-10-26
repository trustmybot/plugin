### Added
- **New source files must say what they are for** (GH 1844): a new L1 lint fails a branch that adds a `.ts`, `.tsx` or `.sh` source file without a one-line purpose header comment, so the world model can describe every new file. Tests, fixtures, `dist/`, `.d.ts` and generated files are exempt; the rule is in `docs/contributing/FILE_HEADERS.md`.
