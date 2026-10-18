### Changed
- **Rework spawns no longer get denied for effort** (GH 1359): the `tmb_planning` effort table and rework section now tell bro to raise the task's stored effort first with `task_reopen(..., effort='high')` or `task_retry(..., effort='high')` and then spawn swe with the same value, so the spawn gate sees matching efforts instead of denying a bare `high` spawn on a `medium` task.
