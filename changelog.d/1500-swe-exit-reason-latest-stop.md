### Fixed
- **A swe run's exit_reason is its latest stop's** (GH 1500): the SubagentStop hook now overwrites `exit_reason` on every stop instead of keeping the first one, and a resumed swe reuses its spawn's row, so a task that closed after a resume no longer shows its swe run as `failed`.
