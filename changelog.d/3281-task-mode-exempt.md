### Changed
- **A task's stored mode can now read exempt** (GH 3281): the mode a task closed under is truest, agile or exempt, so a task in an exempt repo can carry its repo's mode. The project's `workflow_mode` setting still takes only truest or agile, and tasks you already closed keep the mode they have.
