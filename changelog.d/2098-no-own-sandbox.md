### Changed
- **CONTAINMENT.md drops the planned per-task sandbox** (GH 2098): TMB builds no sandbox of its own; Claude Code's Bash sandbox is the only wall for Bash, and a swe's Bash command is held to the project, not to its task's worktree.
