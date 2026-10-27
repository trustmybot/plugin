### Changed
- **`no-source-edit-from-main` has a TypeScript version, and it now allows a scratch write under `/private/tmp/claude-<uid>` on macOS** (GH 1692, GH 1796). The gate is ported from `scripts/hooks/no-source-edit-from-main.sh` to `mcp/trajectory-server/src/hooks/no-source-edit-from-main.ts` and listed in `dist/hooks-gates.txt`, so `dispatch.sh` runs it through node (`TMB_HOOKS_IMPL=bash` still runs the .sh). It keeps the .sh's decisions and deny text:
  - Outside a task worktree, an Edit, Write, MultiEdit or NotebookEdit to source in a registered repo is denied unless the target is on the docs and config allowlist or the caller is a swe. `TMB_ALLOW_SOURCE_EDIT=1` lifts this rule.
  - The plugin's own `scripts/hooks/` and `hooks/hooks.json` are denied even for a swe.
  - A Bash write to a prompt-surface file outside a worktree is denied for everyone.

  A 47-payload corpus in `tests/fixtures/hook-corpus/no-source-edit-from-main/` runs both versions in the C and `en_US.UTF-8` locales against a sandbox of real git repos and trajectory DBs. Both versions print byte-identical output. The corpus covers:
  - every tool the gate judges, a tool it ignores, and a payload that is not JSON
  - the bypass env, no DB, a corrupt DB and a DB without a repos table
  - worktree, scratch, unregistered-repo and outside-git targets
  - each allowlist entry, the swe permit and both enforcement surfaces
  - Bash writes to prompt surfaces, reads, and a project under a `.claude/worktrees/` path

  The `no-source-edit-from-main` l3 suite passes against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript version differs from the .sh only in these places. Each has a payload in the corpus marked `corpus_divergent`:
  - **Scratch roots are compared canonically** (GH 1796). The target and the scratch roots (`.claude/tmb/scratch/` and `/tmp/claude-<uid>`) are resolved before the prefix check. On macOS, where `/tmp` links to `/private/tmp`, a new file under `/private/tmp/claude-<uid>` was denied as main-checkout source; it is now allowed, as is a write through a link into `.claude/tmb/scratch/`. Main-checkout source and a `..` climb out of scratch are still denied.
  - **No jq or `sqlite3` CLI needed** (decision 703). Without jq, the .sh allowed every call. Without the `sqlite3` CLI, it skipped the registration check and denied writes to unregistered repos.
