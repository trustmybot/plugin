### Changed
- **The swe-run hooks have TypeScript versions** (GH 1692): four hooks are ported from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/` and listed in `dist/hooks-gates.txt`, so `dispatch.sh` runs them through node (`TMB_HOOKS_IMPL=bash` still runs the .sh). Their policy, bypass variable, messages and DB writes are unchanged:
  - `swe-brief-gate` denies a swe that has not called `task_brief` for its task on a trajectory-server tool or on Edit, Write or NotebookEdit, and on `task_brief` binds the spawn's run row or audits a resumed swe.
  - `swe-spawn-bind` rebinds an accepted swe spawn's `tool_use:<id>` run row to its agent id.
  - `swe-spawn-rollback` moves a task back to pending and sweeps its run row when auto mode refuses the swe spawn.
  - `post-task-create-spawn-hint` names each task `task_create_batch` created, with its worktree read from the trajectory DB, and reminds bro to spawn every swe in one turn.

  A 65-payload corpus in `tests/fixtures/hook-corpus/` runs each hook through both versions in the C and `en_US.UTF-8` locales. Each payload runs against a freshly rebuilt sandbox. Both versions exit the same way, print byte-identical stdout and stderr, and leave identical tasks, agent_runs and audit rows behind. The corpus covers:
  - every allow, deny and hint branch, and the bypass variable
  - run binding, resume auditing and rollback, including a row already keyed, another open run and a measured run
  - namespaced agent types and tool names, quoted and numeric ids, and stdin that is not one JSON object
  - missing, corrupt and schema-only DBs: the brief gate still denies on a corrupt DB, as the .sh does, and the other three fail open

  The `swe-brief-gate` and `post-task-create-spawn-hint` l3 suites pass against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript hooks differ from the .sh only where they no longer need a CLI tool (decision 703). Each difference has a payload in the corpus marked `corpus_divergent`:
  - **No jq needed.** Without jq, each .sh exited untouched. The TypeScript `swe-brief-gate` still denies an unbriefed swe, `swe-spawn-bind` still binds the run row, `swe-spawn-rollback` still rolls the spawn back, and `post-task-create-spawn-hint` still prints its hint.
  - **No `sqlite3` CLI needed.** The TypeScript hooks read and write the trajectory DB through Node's built-in `node:sqlite`. Without `sqlite3`, the .sh brief gate let every call through, the bind and rollback skipped their writes, and the hint reported each worktree as a failed DB read; the TypeScript hooks deny, write and place each worktree.
