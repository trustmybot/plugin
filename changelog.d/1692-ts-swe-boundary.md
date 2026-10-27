### Changed
- **swe-boundary runs in TypeScript** (GH 1692): the PreToolUse gate that keeps swe inside its worktree, off prompt-surface paths and away from pushes and gh/glab mutations is now `mcp/trajectory-server/src/hooks/swe-boundary.ts`. Its decisions, deny and context messages and `hook_block_bypassed` audit rows match `swe-boundary.sh` byte for byte over a 64-payload corpus in the C and UTF-8 locales. The corpus covers rules (a) through (h), non-swe callers, an unresolved context, a missing DB, the prompt-bearing lift, `CLAUDE.md`, the scratchpad allow, heredoc data, variable targets and the loop back-edge rows. The swe-boundary l3 suite passes against both versions. `TMB_HOOKS_IMPL=bash` runs the .sh again. The files[] scope fence is a shared lib, `src/hooks/lib/scope-fence.ts`, and the gh/glab mutation, prompt-surface, worktree-root, target-task and path-digest helpers are ported beside it. It differs from the .sh in four stricter ways:
  - A command that tree-sitter-bash cannot parse is denied, with a message asking you to split it or fix its quoting. The .sh judged the statements it misread.
  - It reads the trajectory DB through Node's built-in `node:sqlite`, so it enforces its rules on a machine with no `sqlite3` CLI. The .sh enforced nothing there.
  - It upper-cases a `gh api` method with JavaScript's `toUpperCase`, so `gh api -X poſt …` is a `POST` mutation and denied in every locale. The .sh's `tr` does that only in a UTF-8 locale and lets it through under `LC_ALL=C`.
  - It denies a Bash write to a prompt-surface path with a multibyte name, such as `echo x > agents/é.md`. Under a UTF-8 locale on macOS the .sh's awk fails on the name, finds no write path and allows it (GH 2030).

  A write target the analyzer cannot judge (a path a program builds at run time) is left to containment-guard, which denies it.

  Cold-process wall time is the median of 25 runs of an `Edit` through `dispatch.sh swe-boundary`, measured on macOS with node 24.15:

  | Payload | `TMB_HOOKS_IMPL=bash` | default (TypeScript) |
  |---|---:|---:|
  | Edit inside the worktree (allowed) | 160 ms | 123 ms |
  | Edit outside the worktree (denied) | 185 ms | 166 ms |
