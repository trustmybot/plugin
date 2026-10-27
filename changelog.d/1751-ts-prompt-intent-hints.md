### Changed
- **The prompt-intent hook has a TypeScript version, and its headless hint skips questions and quoted `claude -p`** (GH 1692, GH 1751): `prompt-intent-hints` is ported from `scripts/hooks/prompt-intent-hints.sh` to `mcp/trajectory-server/src/hooks/` and listed in `dist/hooks-gates.txt`, so `dispatch.sh` runs it through node (`TMB_HOOKS_IMPL=bash` still runs the .sh). Its hint classes, their order and wording, the `TMB_DISABLE_*_HINT` switches and the consultant-spawn audit row are unchanged. The headless hint counts its gate entries in-process instead of starting a second node.

  A 65-payload corpus in `tests/fixtures/hook-corpus/prompt-intent-hints/` runs the hook through both versions in the C and `en_US.UTF-8` locales, each against a freshly rebuilt sandbox. Both versions print byte-identical stdout and stderr and leave identical audit rows. The corpus covers:
  - a positive and a negative for every hint class, and each disable switch
  - empty, all-whitespace and non-JSON input, harness turns, `!` shell spans and injected `<system-reminder>` blocks (GH 1809)
  - onboarded, schema-only and headless-enforced DBs

  The l3 suite passes against both versions; `TMB_HOOK_TEST_IMPL=ts` picks the TypeScript one.

  The TypeScript hook differs from the .sh in three ways, each with `corpus_divergent` payloads:
  - **The headless hint no longer fires on a question or a quote about `claude -p` (GH 1751).** `claude -p` and `claude --print` count only outside quoted spans and fenced blocks, and only in a clause that does not end in `?`. The other headless phrases count only outside quoted spans and fenced blocks. `What is the L0 success criteria? I thought it should be claude -p "@bro health check" and everything is green?` no longer asks for headless consent; `set up claude -p for CI` still does.
  - **No jq needed.** Without jq, the .sh gave no hint; the TypeScript hook still hints.
  - **No `sqlite3` CLI needed.** The TypeScript hook reads the trajectory DB through Node's built-in `node:sqlite`. Without `sqlite3`, the .sh skipped every DB-backed hint.
