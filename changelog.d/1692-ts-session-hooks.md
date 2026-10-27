### Changed
- **The session and prompt hooks run in TypeScript** (GH 1692): six hooks moved from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/`. Their output and messages are unchanged:
  - `session-start-persona` loads the bro persona at session start.
  - `user-prompt-persona` loads the persona on a session's first prompt.
  - `plugin-hooks-marker` writes the per-session marker that tells the headless shim to stand down.
  - `session-log-capture` appends each prompt to the session log.
  - `debug-trajectory` records each tool call in eval debug mode.
  - `activation-routine` handles the bro activation context and the trajectory-server HALT notice.

  A 77-payload corpus in `tests/fixtures/hook-corpus/` runs each hook through both versions in the C, `en_US.UTF-8` and `UTF-8` locales. Each payload runs against a freshly rebuilt sandbox, and both versions print byte-identical stdout, exit the same way and leave the same files and DB rows. The corpus covers:
  - missing fields
  - no trajectory DB
  - a project that was never onboarded
  - every output branch

  The five l3 suites pass against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one. `TMB_HOOKS_IMPL=bash` runs the .sh again.

  Number literals in a payload keep their jq 1.7 spelling in the session log and in the debug args (`1.000`, `1E+2`, `-0`).

  The TypeScript hooks differ from the .sh only where they are stricter or no longer need a CLI tool (decision 703):
  - **No jq needed.** Without jq, `plugin-hooks-marker` still writes its marker, where the .sh exited without one. `session-log-capture` still logs the prompt, where the .sh appended nothing.
  - **No jq or `sqlite3` CLI needed.** They read and write the trajectory DB through Node's built-in `node:sqlite`. Without either tool, `activation-routine` still emits its context, and `debug-trajectory` still records the tool call. The .sh did neither.
  - **Invalid UTF-8 in the persona.** In the no-jq raw-text mode, invalid UTF-8 in the plugin's `CLAUDE.md` prints as U+FFFD. The .sh printed the raw bytes.
  - **Newer Unicode letters.** `activation-routine` matches the word `bro` with Node's Unicode tables (Unicode 17 on node 24). macOS `grep` uses older tables, so under a UTF-8 locale a letter that only the newer tables know is a word character to the TypeScript hook but not to `grep`. One example is U+A7CB. `bro` right next to such a letter is no longer the word `bro` to the TypeScript hook.

  Wall time is the median of 25 runs through `dispatch.sh`, with `CLAUDE_PLUGIN_ROOT` set to the checkout, on an onboarded project. It was measured on macOS 26.6 with node 24.15:

  | Hook | `TMB_HOOKS_IMPL=bash` | TypeScript |
  |---|---:|---:|
  | `session-start-persona` (startup) | 598 ms | 365 ms |
  | `activation-routine` (`hey bro`) | 619 ms | 424 ms |
