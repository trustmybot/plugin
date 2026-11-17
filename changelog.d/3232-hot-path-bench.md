### Added
- **A hot-path benchmark for hooks and MCP latency** (GH 3232): `hot-path.bench` times each hook event's wall time with all its registered hook processes running at once, and an MCP tool's latency while another tool waits on a `gh` call. `--baseline` compares a PR's run with the base branch's and exits 1 on a regression, so each performance fix shows its before and after.
