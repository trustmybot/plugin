### Changed
- **The git branch guards have TypeScript versions** (GH 1692): four hooks are ported from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/` and listed in `dist/hooks-gates.txt`, so `dispatch.sh` runs them through node (`TMB_HOOKS_IMPL=bash` still runs the .sh). Their policy, bypass variables and messages are unchanged:
  - `stay-on-base-guard` denies a `git checkout` or `git switch` onto an open task's branch outside a worktree and names the task's worktree.
  - `branch-up-to-date-with-remote` denies `git worktree add` of a branch that is behind `origin/<target>` (`TMB_ALLOW_STALE_BRANCH=1` bypasses).
  - `no-worktree-branch-create` denies `git worktree add` that creates a branch or detaches HEAD (`TMB_ALLOW_WORKTREE_BRANCH_CREATE=1` and `TMB_ALLOW_WORKTREE_DETACH=1` bypass).
  - `no-remote-auth-guard` denies an interactive `gh auth login` or `glab auth login` in a repo with no remote URL.

  A 73-payload corpus in `tests/fixtures/hook-corpus/` runs each hook through both versions in the C and `en_US.UTF-8` locales, split into three parity shards. The sandbox holds real git repos with local bare origins: a repo with a branch behind origin, one targeting `dev`, a linked worktree, a repo with an empty remote URL and an unregistered one. Both versions exit the same way and print byte-identical stdout. The corpus covers every allow, deny and bypass branch, `git -C` and `cd` targets, non-Bash tools, stdin that is not one JSON object, and missing and corrupt DBs. The four l3 suites pass against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript hooks differ from the .sh in three places. Each difference has a payload in the corpus marked `corpus_divergent` and a unit test:
  - **No jq needed** (decision 703). Without jq, each .sh exited untouched; the TypeScript hooks still deny.
  - **No `sqlite3` CLI needed** (decision 703). The TypeScript hooks read the trajectory DB through Node's built-in `node:sqlite`. Without `sqlite3`, each .sh let the command through; the TypeScript hooks deny.
  - **A command that cannot be parsed is denied** (decision 369). When tree-sitter-bash cannot parse the command and the trajectory DB resolves, each hook denies with git-guards' parse-failure message, as `git-guards`, `git-push-guard` and `swe-boundary` do. The .sh judged whatever its awk skeleton read. With no DB the hooks still allow.
