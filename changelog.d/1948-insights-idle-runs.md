### Fixed
- **Idle runs no longer crowd out the slowest real work in Insights** (GH 1948): Top runs by duration shows tool uses and output tokens and lists runs that sat idle for over 30 minutes last, labelled "Likely idle". Slowest verification commands counts `(cmd)` and `cmd` as one command.
