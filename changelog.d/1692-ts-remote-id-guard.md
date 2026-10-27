### Changed
- **The remote-id guard has a TypeScript version** (GH 1692): `remote-id-guard` is ported from `scripts/hooks/remote-id-guard.sh` to `mcp/trajectory-server/src/hooks/remote-id-guard.ts` and listed in `dist/hooks-gates.txt`, so `dispatch.sh` runs it through node (`TMB_HOOKS_IMPL=bash` still runs the .sh). Its policy is unchanged: it denies a `gh` or `glab` remote write whose author text cites a local issue id that the remote numbers differently, and names the remote iid. The deny text, the fail-open cases and the `TMB_DISABLE_REMOTE_ID_GUARD=1` bypass are the same. It reads the matching issues in one DB query per call.
- **The remote-id guard's deadline runs in-process** (GH 1861): the GH 1821 deadline is now a time budget inside the gate rather than a killed process group. `TMB_REMOTE_ID_GUARD_DEADLINE_S` keeps its default of 3 seconds and its validation, and an invalid value still falls back to 3. On overrun the guard still allows, prints one stderr line and writes one `remote_id_guard_overrun` audit row on issue -1. Tests reach the overrun path through `TMB_REMOTE_ID_GUARD_TEST_OVERRUN=1`, which makes the budget read as spent, so no test waits on the clock.

  A 31-payload corpus in `tests/fixtures/hook-corpus/remote-id-guard/` runs the guard through both versions in the C and `en_US.UTF-8` locales. Both versions exit the same way and print byte-identical stdout. The corpus covers:
  - `gh` and `glab` writes, long and short text flags, heredoc bodies, and `bash -c`
  - which iid gets cited: GitHub's or GitLab's, by the command's forge, with a fallback to the other forge's iid
  - aligned, unmapped and non-local ids, and explicit remote markers
  - local titles that hold a bar, a newline or printf escapes
  - reads, quoted text and heredoc data
  - the bypass, and invalid and fractional deadlines
  - missing, corrupt and issue-less DBs

  The l3 suite passes against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript guard differs from the .sh only where decision 703 allows. Each difference has a payload marked `corpus_divergent` and a unit test:
  - **No jq needed.** Without jq the .sh exited 1 with `remote-id-guard: jq not found`. The TypeScript guard reads the payload itself and still denies.
  - **No `sqlite3` CLI needed.** Without `sqlite3` the .sh let every call through. The TypeScript guard reads the issues through Node's built-in `node:sqlite` and still denies.
  - **A command tree-sitter cannot parse is allowed.** An example is an unterminated quote, which bash itself refuses to run. The guard fails open, where the .sh read such a command with its awk skeleton and could deny it.
