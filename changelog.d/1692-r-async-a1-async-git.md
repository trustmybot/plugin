### Changed
- **Gate git work runs on async child processes** (GH 1692): the hook gates now run `git` without blocking the router's event loop, and each gate's deadline lives in its own async scope instead of one process-wide value. A git past its deadline is still killed and still marks its gate over budget; gate order, budgets and verdicts are unchanged.
