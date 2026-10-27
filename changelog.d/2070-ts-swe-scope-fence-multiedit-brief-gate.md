### Changed
- **`swe-scope-fence` has a TypeScript version, and `swe-brief-gate` now denies MultiEdit before the brief** (GH 1692, GH 2070). `swe-scope-fence` is ported from `scripts/hooks/swe-scope-fence.sh` to `mcp/trajectory-server/src/hooks/swe-scope-fence.ts` and listed in `dist/hooks-gates.txt`, so `dispatch.sh` runs it through node (`TMB_HOOKS_IMPL=bash` still runs the .sh). It still never denies. When a swe's Edit, Write, MultiEdit or NotebookEdit targets a path inside its worktree but outside the task's files[], it adds a note once per path, with the same text and the same marker under `locks/scope-notes/`.

  A 26-payload corpus in `tests/fixtures/hook-corpus/swe-scope-fence/` runs both versions in the C and `en_US.UTF-8` locales, each against a freshly rebuilt sandbox. Both versions print byte-identical output and leave the same note markers. The corpus covers:
  - another role, an unresolved context, no DB and a corrupt DB
  - an empty files[], a path inside files[], and a path outside it
  - a path noted a second time
  - a relative target joined to the payload cwd or `PWD`
  - a target outside the worktree
  - a symlinked worktree

  The `swe-scope-fence` l3 suite passes against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript versions differ from the .sh only in these places. Each has a payload in the corpus marked `corpus_divergent`:
  - **No jq or `sqlite3` CLI needed** (decision 703). Without jq or without the `sqlite3` CLI, the .sh stayed silent. The TypeScript `swe-scope-fence` still notes a write outside files[].
  - **MultiEdit is denied before the brief** (GH 2070). `hooks.json` routes MultiEdit to `swe-brief-gate`, but the .sh left it off its list, so a swe that had not called `task_brief` could still use MultiEdit. The TypeScript gate denies it with the same text as Edit; a briefed swe's MultiEdit still passes.
