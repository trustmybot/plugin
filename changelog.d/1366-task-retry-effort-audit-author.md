### Fixed
- **`task_retry` audit rows name the agent that called it** (GH 1366): `task_retry` recorded `task_retry_attempted` and `task_effort_raised` with a hardcoded `bro` author, unlike `task_reopen`. Both rows now carry the validated calling agent.
