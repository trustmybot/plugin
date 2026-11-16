### Changed
- **Closing an agile task by hand queues it for review** (GH 2225): under the agile workflow, `task_update_status` closing a task with no passing review now queues it for the grouped review instead of recording that the review was bypassed, and closing it through a merged pull request no longer records a bypass either. The default workflow is unchanged.
