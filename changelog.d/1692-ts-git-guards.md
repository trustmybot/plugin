### Changed
- **git-guards runs in TypeScript** (GH 1692): the PreToolUse gate that enforces the repo's branching model (PRs and MRs target `pr_target`, no local merge, rebase, cherry-pick or commit on a shared workflow base, no force push to a protected branch, new branches start from the latest `pr_target`) is now `mcp/trajectory-server/src/hooks/git-guards.ts`. Its decisions and deny messages match `git-guards.sh` byte for byte over a 60-payload corpus run against real git repos and a trajectory DB, in the C and UTF-8 locales. The corpus covers github-flow and gitflow, unregistered and policy-less repos, ambiguous and unresolved targets, `gh pr create --base`, `glab mr create`, heredoc commit messages that name git, and the no-git early exit. The git-guards l3 suite passes against both versions. `TMB_HOOKS_IMPL=bash` runs the .sh again. It differs from the .sh in four ways. Three are stricter, and the fourth matches what the .sh does wherever `sqlite3` is installed:
  - A command naming git, gh or glab that the bash parser cannot read faithfully is denied with a message asking you to split it or fix its quoting. The .sh judged the statements it misread, so a commit hidden after a misparsed heredoc could go through.
  - The no-git early exit reads only ASCII letters and digits as word characters in every locale. In a UTF-8 locale the .sh skipped a `git` word right after a non-ASCII letter, such as `égit commit`. The TypeScript gate analyses it, as the .sh does in the C locale.
  - It reads the trajectory DB through Node's built-in `node:sqlite`, so it applies the registered policy even on a machine with no `sqlite3` CLI, as the .sh does wherever the CLI exists. Without the CLI, the .sh guarded every repo with the default policy, including repos never registered.
  - A switch-then-fast-forward sync (`git switch <branch> && git merge --ff-only @{u}`) is allowed only when the whole command is ASCII. The .sh's awk fails on a quoted non-ASCII character in a UTF-8 locale on macOS and so denied it there. The TypeScript gate denies it in every locale.

  Wall time is the median of 25 runs of `git commit -m x` through `scripts/hooks/dispatch.sh`, measured on macOS with node 24.15. The TypeScript gate is slower on both payloads.

  | Payload | `git-guards.sh` | TypeScript |
  |---|---:|---:|
  | Commit on a feature branch (allowed) | 402 ms | 618 ms |
  | Commit on `main` (denied) | 546 ms | 872 ms |
