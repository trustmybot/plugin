### Fixed
- **Scratch files have a place the guards always allow** (GH 1597): `.claude/tmb/scratch/` in your project or the agent's worktree, and Claude Code's own `/tmp/claude-<uid>` temp dir, are now writable even when `$TMPDIR` points somewhere else, and the block messages name them so an agent knows where to put scratch scripts and notes.
