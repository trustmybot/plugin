### Changed
- **git-push-guard runs in TypeScript** (GH 1692): the PreToolUse gate that blocks swe and pr-reviewer pushes, pushes from `.claude/worktrees/`, pushes of unsigned task commits and pushes of rebased task commits with no verification run is now `mcp/trajectory-server/src/hooks/git-push-guard.ts`. Its decisions and deny messages match `git-push-guard.sh` byte for byte over a 36-payload corpus run against real git repos and a trajectory DB, in the C and UTF-8 locales. The four git-push-guard l3 suites pass against both versions. `TMB_HOOKS_IMPL=bash` runs the .sh again. It differs from the .sh in two accepted ways (decision 369):
  - A command naming `push` that the bash parser cannot read faithfully is denied with a message asking you to split it or fix its quoting. The .sh judged the statements it misread, so a push hidden after a misparsed heredoc could go through (GH 1927).
  - It reads the trajectory DB through Node's built-in `node:sqlite`, so it checks commits even on a machine with no `sqlite3` CLI. The .sh skipped the check there.

  Cold-process wall time is the median of 25 runs of `git push origin main` piped to the gate directly, measured on macOS with node 24.15:

  | Payload | `git-push-guard.sh` | TypeScript |
  |---|---:|---:|
  | Signed commit (allowed) | 157 ms | 124 ms |
  | Unsigned commit (denied) | 137 ms | 113 ms |
