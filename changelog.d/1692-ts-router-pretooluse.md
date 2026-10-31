### Changed
- **Every PreToolUse call now runs its gates in one process** (GH 1692). `hooks/hooks.json` has one exec-form router entry per tool group: `Write|Edit|MultiEdit|NotebookEdit`, `Bash`, `Agent`, `SendMessage`, `mcp__.*trajectory-server__.*`, `AskUserQuestion` and `Read|Skill`. A tool that no group matches runs no gates.
  - Gates in a group now run one at a time in a fixed order, where the separate `dispatch.sh` entries ran in parallel. A slow Write or AskUserQuestion gate now delays the next gate instead of running beside it.
  - The `trajectory-server` group keeps the chain's behaviour: the first deny ends the group, and any gate failure denies. Other groups run every gate and the first deny in group order wins.
  - Each group has its own budget in `src/hooks/router/budgets.json`, so `swe-verification-gate`'s 1830 s applies to the `trajectory-server` group only; a Bash call stays bounded by the Bash group's budget. Each entry's timeout is derived from its group's budget.
  - The headless shim runs each group's gates through `dispatch.sh`, and the `trajectory-server` group through `dispatch.sh trajectory-gates`. `TMB_HOOKS_IMPL=bash` still runs the `.sh` gates through `dispatch.sh` and its chain table.
  - `debug-trajectory` now also records `NotebookEdit`.
