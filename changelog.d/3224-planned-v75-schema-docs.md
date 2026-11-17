### Changed
- **The ERD and ENUMS docs now describe the planned schema v75 task lifecycle tables and statuses** (GH 3224), ahead of the code. The v75 release regenerates the real tables and replaces these sections.
- **TASKS, FLOWS and AGILE now cover the lifecycle cases their charts left out** (GH 3224): the stale run, the recovery close, a merge outside the flow, an issue closed over open tasks, and how a queued agile task leaves the queue for a review on request, for rework, or when its feature branch is dropped.
