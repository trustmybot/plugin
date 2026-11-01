### Changed
- **A large commit diff at task close goes to a subagent** (GH 2193): bro used to read the whole commit diff into its own context, whatever its size. Now, at task close, a diff too large to judge directly goes to a subagent that reports against the `SC<n>` ids.
