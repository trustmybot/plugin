### Fixed
- **The README-staleness nudge has a TypeScript version that reads READMEs from the closed commit's tree** (GH 1692, GH 2044, GH 1792): the `post-atomic-close-readme` PostToolUse hook is ported from `scripts/hooks/post-atomic-close-readme.sh` to `mcp/trajectory-server/src/hooks/` and listed in `dist/hooks-gates.txt`. Its labels, nudge text and `readme_staleness_surfaced` audit row are unchanged.

  The verdict now comes from git alone. A touched dir whose README is absent from the commit's tree reads `(no README.md)`. One whose README exists but is not among the commit's changed paths reads `(README.md older than the commit)`. A dir whose README the commit changed gets no line, and a dir with a `dist` path segment is skipped.
  - **GH 2044.** The .sh read the main checkout. A commit on a branch the checkout lacked was flagged for adding a README the checkout did not have yet.
  - **GH 1792.** The .sh compared the checkout README's mtime to the commit date, so a commit that edited a README could still flag it as older than the commit.

  A 23-payload corpus in `tests/fixtures/hook-corpus/post-atomic-close-readme/` runs both versions against real git repos in the C and `en_US.UTF-8` locales. Both versions print byte-identical stdout and stderr and leave identical audit rows. The l3 suite passes against both; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript gate differs from the .sh only where decision 703 allows. Each difference has a payload marked `corpus_divergent`:
  - **The git-tree rule.** It covers GH 2044, GH 1792 and the `dist` skip.
  - **No jq needed.** Without jq the .sh exited silently; the TypeScript gate still nudges.
  - **No `sqlite3` CLI needed.** The TypeScript gate reads the task and writes the audit row through Node's built-in `node:sqlite`, where the .sh exited silently.
