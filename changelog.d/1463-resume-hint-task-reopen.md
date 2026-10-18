### Fixed
- **Resuming a planned task** (GH 1463): the resume-intent hint now tells bro to call `task_reopen` so the task gets a worktree before swe starts, instead of `git switch` in the main checkout, which left swe with nowhere to work.
