### Fixed
- **A resumed swe spawn no longer trips the `swe_runs_metered` doctor error** (GH 1431): when a swe spawn resumed after a terminal task status and called `task_brief` again, the second unkeyed `agent_runs` row stayed all-zero and was reported as unmetered. The SubagentStop hook now marks that duplicate row `unmeasured` with `exit_reason='swept_orphan'`.
