### Changed
- **The code-reviewer spawn gates have TypeScript versions** (GH 1692): three PreToolUse(Agent) gates are ported from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/` and listed in `dist/hooks-gates.txt`. Their policy, bypass variables and messages are unchanged. `agent-spawn-dispatch.sh` still runs the .sh versions:
  - `code-reviewer-no-worktree` denies a code-reviewer spawn with `isolation: "worktree"`.
  - `code-reviewer-spawn-prompt-shape` denies a code-reviewer prompt that is missing an anchor or carries a rubber-stamp shortcut. Its anchor list comes from `code-reviewer-spawn-note`'s, so the two cannot drift.
  - `code-reviewer-after-atomic-close` denies a code-reviewer spawn whose `task_id` is not yet closed.

  A 52-payload corpus in `tests/fixtures/hook-corpus/` runs each gate through both versions in the C and `en_US.UTF-8` locales. Each payload runs against a freshly rebuilt sandbox. Both versions exit the same way, print byte-identical stdout and stderr, and leave identical sandboxes behind. The corpus covers:
  - every allow and deny branch, and each bypass variable
  - namespaced agent types, and stdin that is not one JSON object
  - anchors glued to a word, phrases in any ASCII case, and characters whose grep reading depends on the locale
  - closed, unclosed and missing tasks, and missing, corrupt and schema-only DBs

  The `code-reviewer-no-worktree` l3 suite passes against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript gates differ from the .sh only where they no longer need a CLI tool (decision 703). Each difference has a payload in the corpus marked `corpus_divergent`:
  - **No jq needed.** Without jq, the .sh read an empty payload, so each gate let the spawn through. The TypeScript gates still deny a worktree spawn, a malformed prompt and an unclosed task.
  - **No `sqlite3` CLI needed.** `code-reviewer-after-atomic-close` reads the trajectory DB through Node's built-in `node:sqlite`, so it denies an unclosed task where the .sh let the spawn through without `sqlite3`.
