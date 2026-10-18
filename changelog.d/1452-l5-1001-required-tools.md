### Fixed
- **L5 10.01-difficult-task no longer fails on a call no doctrine asks for** (GH 1452): the row's `tools-required.json` demanded a direct `audit_append` call, but `task_provision` already writes the planning_complete audit row that `outcome.sql` checks, so the row now requires `task_provision` instead.
