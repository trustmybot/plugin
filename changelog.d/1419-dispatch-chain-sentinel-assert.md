### Fixed
- **The hook test suite is green again after the task_brief sentinel move** (GH 1419): the dispatcher chain test still expected swe-brief-gate to write the swe_brief_fetched row; it now asserts the handler-owned contract.
