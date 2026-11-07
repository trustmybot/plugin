### Fixed
- **Hook golden recordings match the 12 seeded cheatcodes** (GH 2424): the `tests/fixtures/hook-golden/` recordings for bro-turn-usage, deferred-tools-drift-warn, ensure-gitignore, mcp-health-check and substrate-preflight now record `cheatcodes=12` in their trajectory.db row counts, so the `hooks-health-parity` shards pass again after the 12th builtin cheatcode seed (GH 2336).
