### Changed
- **The Agent-spawn dispatcher runs in TypeScript** (GH 1692): three hooks are ported from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/` and listed in `dist/hooks-gates.txt`, so `dispatch.sh` runs them through node (`TMB_HOOKS_IMPL=bash` still runs the .sh). Their policy, bypass variables, messages and DB writes are unchanged:
  - `agent-spawn-dispatch` runs the nine spawn gates in order in the same process: require-task-spec, require-spawn-effort, require-feature-branch-active, the five code-reviewer gates and rework-limit. It prints the first deny verbatim. When nothing denies, it runs the two PREPARE steps fail-open and joins the gates' additionalContext parts with a `---` line.
  - `ensure-swe-worktree` adds a swe task's worktree at `<repo>/.claude/worktrees/<slug>` with `git worktree add`, and stays silent when the worktree is already registered.
  - `record-swe-spawn` opens the swe spawn's agent_runs row. In the same transaction it sweeps the task's stale unbound runs and moves a pending task to running. Its SQL is unchanged byte for byte.

  A 73-payload corpus in `tests/fixtures/hook-corpus/` runs each hook through both versions in the C and `en_US.UTF-8` locales, against real git repos and trajectory DBs that are rebuilt for every payload. Both versions exit the same way, print byte-identical stdout and stderr, and leave identical worktrees, tasks and agent_runs rows behind. The corpus covers:
  - each chained gate's deny
  - allow and bypass
  - non-Agent and malformed stdin
  - every repo-root form: a named repo, a repo without a path, a single repo, the workspace root and a trailing slash
  - effort and model forms, and the session fallback for the spawn id
  - the sweep
  - missing and corrupt DBs

  The `agent-spawn-dispatch` and `ensure-swe-worktree` l3 suites pass against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript hooks differ from the .sh in three accepted ways. Each difference has a payload in the corpus marked `corpus_divergent`:
  - **A recorded worktree is honored (GH 2032).** When a task's recorded `tasks.worktree_path` exists, `ensure-swe-worktree` leaves it in place instead of running `git worktree add` at the slug path. `record-swe-spawn` also writes that path as the run's `root_dir`. When the recorded path is gone, both fall back to the slug path, as the .sh did. The .sh always used the slug path, so for a task that adopted a session worktree it failed to add a second worktree on the same branch and recorded a `root_dir` swe never worked in.
  - **No jq needed.** Without jq, the .sh dispatcher exited 1 with `agent-spawn-dispatch: jq not found`, and the PREPARE steps did nothing. The TypeScript dispatcher still runs every gate, the worktree is still added, and the run row is still recorded.
  - **No `sqlite3` CLI needed.** The TypeScript hooks read and write the trajectory DB through Node's built-in `node:sqlite`. Without `sqlite3`, the .sh hooks skipped the worktree and the run row; the TypeScript hooks add the worktree and record the run.
