### Changed
- **The hook router has no bash path left** (GH 1692). `TMB_HOOKS_IMPL=bash` no longer switches the router to `scripts/hooks/<gate>.sh`: every gate runs from the TypeScript registry, whatever the environment.
  - The spawn hint after `task_create` now tells bro to pre-create a worktree with `node ${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js worktree-create`, where it named `scripts/hooks/worktree-create.sh`.
  - The world model links each `hooks/hooks.json` gate to its TypeScript module, `mcp/trajectory-server/src/hooks/<gate>.ts`, and no longer to `scripts/hooks/<gate>.sh`. The symbol extractor version is now 4, so the next scan re-indexes.
