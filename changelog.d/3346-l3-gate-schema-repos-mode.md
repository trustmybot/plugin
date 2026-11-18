### Fixed
- **The verification-gate L3 tests pass again** (GH 3346): their hand-written test schema had no `repos.mode` column (added in schema v76), so the gate's mode read failed and every gated close was denied as "trajectory DB unavailable". The test schema now carries the column.
