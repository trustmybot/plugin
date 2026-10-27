### Changed
- **The roundtable and consultant hooks run in TypeScript** (GH 1692): four hooks moved from `scripts/hooks/<gate>.sh` to `mcp/trajectory-server/src/hooks/`. Their output and messages are unchanged:
  - `roundtable-slash-detect` records the `roundtable_slash_invoked` audit row when the Human types `/roundtable`.
  - `roundtable-cleanup-postcheck` names the capture surfaces a closed roundtable is missing.
  - `roundtable-auq-shape` asks before an AskUserQuestion of the wrong shape while a roundtable awaits the Human.
  - `consultant-persistence-gate` blocks a consultant that stops without a discussion row on the open issue. Its allowlist is unchanged.

  A 71-payload corpus in `tests/fixtures/hook-corpus/` runs each hook through both versions in the C and `en_US.UTF-8` locales. Each payload runs against a freshly rebuilt sandbox. Both versions exit the same way, print byte-identical stdout and stderr, and leave the same audit rows and row counts. The corpus covers:
  - roundtables in every capture state
  - non-array questions
  - number literals as roundtable ids
  - missing, corrupt and schema-only DBs

  The four l3 suites pass against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one. `TMB_HOOKS_IMPL=bash` runs the .sh again.

  The TypeScript hooks differ from the .sh only where they are stricter or no longer need a CLI tool (decision 703). Each difference has a payload in the corpus marked `corpus_divergent`:
  - **No jq needed.** Without jq, the .sh read an empty payload, so each hook let the call through. The TypeScript hooks still run:
    - `roundtable-slash-detect` records its row.
    - `roundtable-cleanup-postcheck` advises.
    - `roundtable-auq-shape` asks.
    - `consultant-persistence-gate` blocks.
  - **No `sqlite3` CLI needed.** The hooks read and write the trajectory DB through Node's built-in `node:sqlite`, so they run where the .sh exited without `sqlite3`.
  - **A multibyte character cut at byte 200.** `roundtable-slash-detect` keeps the first 200 bytes of the prompt in the audit summary. When that cut splits a character, the TypeScript hook stores U+FFFD. The .sh stored the character's lone first byte under `LC_ALL=C`. In a UTF-8 locale, its `sed` failed on that byte, so it stored an empty summary and printed a sed error.
