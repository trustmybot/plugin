### Changed
- **TASKS, FLOWS and AGILE now cover the lifecycle cases their charts left out** (GH 3251): the stale run, the recovery close, a merge outside the flow, an issue closed over open tasks, and how a queued agile task leaves the queue for a review on request, for rework, or when its feature branch is dropped.
- **The planned v75 lifecycle splits escalated into superseded and cancelled** (GH 3251): a retried task is superseded by the task that names it, and a task whose issue closed or whose feature branch was dropped is cancelled.
- **The planned v75 lifecycle renames completed to submitted and queued to review-deferred** (GH 3251), so each state name means what it means in other workflow tools.
- **Planned v75 lifecycle events now name their evidence, cause, actor run and two times** (GH 3251): every move requires a record of a set kind, its cause is a code from a fixed list, it names the agent run that made it, and it keeps both when it happened and when it was recorded.
- **AGILE now says how a failing check or a review comment on the milestone PR is fixed** (GH 3251): a new fix task on the feature branch, reviewed before it merges.
- **Planned v75 records task facts that change no state as events** (GH 3251): an amended spec, a rebased commit and a checkpoint each keep the state and name what changed.
