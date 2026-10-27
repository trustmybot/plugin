### Fixed
- `task_provision` and `task_retry` refuse a branch_id the issue already has a task on with a typed `branch_id_used_on_issue` error (existing task id, status and commit SHA, plus the next step) before any git change, instead of moving the ref and then failing on a raw SQLite UNIQUE error (GH 1731).
