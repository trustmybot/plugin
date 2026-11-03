### Changed
- **The health and drift hooks run in TypeScript** (GH 1692): five hooks moved from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/`. None of them denies, and their output and messages are unchanged:
  - `mcp-health-check` notes at session start when the trajectory-server is not running, gives the install-scope notice once per session, warns about duplicate enabled installs, and appends a line to the project's `mcp-health.log`.
  - `deferred-tools-drift-warn` warns when MCP tool files on disk are newer than the session's running trajectory-server.
  - `substrate-preflight` prints the TMB DEGRADED banner when jq, sqlite3, git or node is missing (same probe list and banner), and the offline note when no repo has a remote URL.
  - `ensure-gitignore` adds `.claude/` to the `.gitignore` of each onboarded repo that does not ignore it.
  - `bro-turn-usage` records each bro turn's tokens, tool uses and model in `agent_runs`.

  A 65-payload corpus in `tests/fixtures/hook-corpus/` runs each hook through both versions in the C and `en_US.UTF-8` locales. Each payload runs against a freshly restored sandbox, and both versions print byte-identical stdout, exit the same way and leave the same files and DB rows. The corpus covers:
  - every output branch
  - missing fields
  - non-ASCII paths
  - a missing jq, sqlite3 or gh

  The five l3 suites pass against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one. `TMB_HOOKS_IMPL=bash` runs the .sh again.

  The TypeScript hooks differ from the .sh only where they are stricter or no longer need a CLI tool. Each difference has a unit test in `src/test/hooks-health.test.ts`:
  - **`mcp-health-check` runs without jq.** It reads the install list and settings with Node's JSON parser and still prints its health notes. The .sh exited silently.
  - **`deferred-tools-drift-warn` runs without jq.** It still warns about drift, where the .sh exited 127 at its final `jq`. It also compares mtimes directly, without a `mktemp` reference file.
  - **`bro-turn-usage` runs without jq or the `sqlite3` CLI.** It reads the transcript with Node and writes the row through `node:sqlite`. The .sh recorded nothing.
  - **`ensure-gitignore` runs without the `sqlite3` CLI.** It reads the onboarded repos through `node:sqlite`, where the .sh fell back to the project directory alone.
  - **Duplicate installs sort by bytes in every locale.** The .sh's `sort` followed `LC_ALL`, so under `en_US.UTF-8` `alpha` sorted before `Zeta`; the TypeScript hook always puts `Zeta` first, as the C locale does.

  Wall time is the median of 25 runs through `dispatch.sh`, each with a new session id, with `CLAUDE_PLUGIN_ROOT` set to the checkout, on an onboarded project. It was measured on macOS 26.6 with node 24.15:

  | Hook | `TMB_HOOKS_IMPL=bash` | TypeScript |
  |---|---:|---:|
  | `mcp-health-check` (server running) | 339 ms | 202 ms |
  | `bro-turn-usage` (200-message transcript) | 278 ms | 239 ms |
