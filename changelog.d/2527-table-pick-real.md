### Fixed
- **Table edges no longer bind to a fixtures copy** (GH 2527): when a table had two or more real definitions, a `reads_table` or `writes_table` edge could resolve to a copy under a `fixtures/` directory. The by-name fallback now prefers a definition outside tests and fixtures, so `world_model_symbol` table lists point at real schema files.
