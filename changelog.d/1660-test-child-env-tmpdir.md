### Fixed
- **The Codex installed-cache test passes inside the Claude Code sandbox** (GH 1660): the test started the server with a fixed environment that dropped `TMPDIR`, so `scan.sh` fell back to `/tmp`, which the sandbox blocks, and `project_scan` failed. The test now passes `TMPDIR` through when the parent has it.
