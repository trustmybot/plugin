### Fixed
- **The worktree-setup process-group kill test no longer fails under load** (GH 2822): it timed the whole `pr_monitor_worktree` call, git worktree add and remove included, against a 2000 ms bound that busy machines overran. The bound is now 5000 ms, still below the 6 s the pipe-holding grandchild would stall the call if the group kill regressed.
