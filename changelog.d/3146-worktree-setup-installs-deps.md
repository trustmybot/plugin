### Fixed
- **Worktree setup installs missing dependencies before building** (GH 3146): a task worktree whose main checkout never installed a lockfile root (the repo root or `dashboard/`) failed setup with `tsc: command not found`; setup now installs any root that still has no `node_modules` before `bun run build:payload`.
