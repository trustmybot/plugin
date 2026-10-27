### Changed
- **A Bash call now runs its 11 PreToolUse gates in one process** (GH 1692, GH 1861). Before, `hooks/hooks.json` started 11 `dispatch.sh` processes for every Bash call. Now one exec-form entry, `node "${CLAUDE_PLUGIN_ROOT}/mcp/trajectory-server/dist/hooks.js" PreToolUse`, runs them in-process through a new TypeScript router.
  - The router keeps `dispatch.sh`'s contracts:
    - the per-call dedupe;
    - the `hook_denied` row and the boundary-denies records;
    - the active-install handoff;
    - fail-closed: a gate that throws, exits non-zero, prints unparseable output, is unknown or runs past its budget denies, naming the gate.
  - Each router call writes one `hook_call` audit row with every gate's time and outcome.
  - Gate budgets come from `src/hooks/router/budgets.json`. They are built from the in-process bench p99 and the p99 recorded in session transcripts. No gate gets less time than its old hooks.json timeout.
