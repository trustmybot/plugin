### Changed
- **bro takes docs- and prompts-only asks itself** (GH 3073): bro's persona now routes a change that touches only the project's declared docs or prompts paths to a no-code task. bro writes the change in the task's own worktree, self-checks it with `tmb_doc-review` before closing, and code-reviewer gates it like any task. Anything that touches code still goes to swe.
