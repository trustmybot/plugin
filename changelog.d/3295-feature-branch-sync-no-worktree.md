### Fixed
- **`cli.js feature-branch sync` works from a sandboxed session** (GH 3295): sync made its merge commit in a temporary worktree, which the Claude Code sandbox could not check out ("unable to create file .mcp.json"); it now builds the merge with no checkout, keeping the same message, parents and conflict exit, and needs git 2.38 or newer.
