# TMB Plugin Tests

Plugin-level tests and contributor testing guide.

> **Framework overview:** see [`docs/testing/`](../docs/testing/) for the three-layer testing strategy, what each layer catches, and when to add a test to which layer. This file is the operational how-to; the docs/ version is the conceptual map.

Three layers on disk:

| Layer | Location |
|---|---|
| 1 — Unit (handlers direct) | [`mcp/trajectory-server/src/test/`](../mcp/trajectory-server/src/test/) |
| 2 — Integration (real server + JSON-RPC) | [`tests/mcp-integration/`](./mcp-integration/) |
| 3 — Dogfood (human, interactive CC) | [`docs/testing/scenarios.md`](../docs/testing/scenarios.md) |

## Quick start — run everything automated (Layers 1 + 2 + hooks + lint)

```bash
# From plugin/ root:
bash tests/run-all.sh
```

Runs, in order:
1. **Layer 1 — MCP unit tests** — handler direct, synthetic args (~235 cases).
2. **Layer 2 — MCP integration** — real server subprocess + JSON-RPC stdio (21 cases across schema-contract, role-matrix, per-agent workflow).
3. **Hook script suite** — bash unit tests for `scripts/hooks/*.sh`.
4. **Agent-budget lint** — enforces 200-line cap on every `agents/*.md`.

Exit code is non-zero if any suite fails.

## Individual suites

### Layer 1 — MCP unit

```bash
cd mcp/trajectory-server
bun run build
node --test dist/test/*.test.js
```

**Adding a test:** drop `src/test/<name>.test.ts` following existing patterns (e.g., `src/test/file-registry.test.ts`). Helpers at `src/test/helpers.ts`. Each file imports `node:test` + `node:assert/strict` and uses `describe` / `it`.

Key helper: `tempDB()` creates an ephemeral SQLite DB preloaded with the current schema.

Catches handler logic errors and DB-constraint violations. Does NOT catch schema drift (the inputSchema layer strips params the LLM didn't know to send) or role enforcement (tests pass `agent: 'x'` synthetically). Both are Layer 2 concerns.

### Layer 2 — MCP integration

```bash
bash tests/mcp-integration/run.sh
```

Spawns the real `node dist/index.js` as a subprocess and speaks JSON-RPC over stdio via the MCP SDK client. Catches schema drift, role-enforcement gaps, required-arg changes, and cross-tool workflow regressions.

Three test categories, one per file:
- `schema-contract.test.mjs` — every tool declares `agent` with the four-role enum.
- `role-matrix.test.mjs` — each `requireRoles`-wrapped tool correctly accepts/rejects per role.
- `agent-{bro,architect,swe,pr-reviewer}-workflow.test.mjs` — each agent's realistic end-to-end MCP sequence.

**Adding a test:** drop `tests/mcp-integration/<name>.test.mjs` importing from `./harness.mjs`. Use `startClient()` + `call()`. Keep each test self-contained with its own `:memory:` DB spawn (the harness handles that). See existing workflow tests for patterns.

### Hook scripts

```bash
bash tests/hooks/run.sh
```

Runs every `tests/hooks/*.test.sh`.

**Adding a test:**

```bash
#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/../lib/assert.sh"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"
HOOK="$PLUGIN_ROOT/scripts/hooks/<your-hook>.sh"

test_case "describe the scenario"
out=$(echo '{"tool_input":{"command":"..."}}' | bash "$HOOK" 2>&1 || true)
assert_contains "$out" "expected-substring"

summarize
```

Assertion helpers in `tests/lib/assert.sh`:

- `assert_eq <expected> <actual> [label]`
- `assert_contains <haystack> <needle> [label]`
- `assert_not_contains <haystack> <needle> [label]`
- `assert_exit_code <expected> <actual> [label]`
- `summarize` — prints pass/fail summary; returns non-zero if any assertion failed.

## Layer 3 — Local dogfood testing (end-to-end, human-driven)

For setting up a scratch project and exercising the plugin end-to-end — install modes, first-run expectations, DB verification, hot reload, reset, the scenario library, and common pitfalls — see [`docs/testing/local-setup.md`](../docs/testing/local-setup.md).

The full scenario library lives at [`docs/testing/scenarios.md`](../docs/testing/scenarios.md): 30+ scenarios across all 9 flows in [`FLOWS.md`](../docs/architecture/FLOWS.md), each with a verbatim trigger prompt, prerequisites, expected behavior, and verification SQL. Walk these before tagging a release.

## Gaps not covered by this suite (worth filing)

- **Agent-prompt validity** — no linter checks frontmatter fields or tool names referenced in prompts. A typo in an agent prompt won't be caught by CI.
- **Skill frontmatter** — same.
- **Snapshot rendering** — no smoke check that the 4 architecture-auto renderers produce non-empty output with generated-headers.
- **Plugin-load simulation** — CI can't easily emulate Claude Code's plugin loader. The manual dogfood checklist is the substitute.

File any testing gap as an issue tagged `testing`.

## CI

`.github/workflows/test.yml` runs both suites on every PR against `dev`. Green required before merge.

## Related

- `scripts/hooks/diagnostic/README.md` — opt-in probe-bash harness for investigating [issue #14](https://github.com/trustmybot/plugin/issues/14) (subagent Bash bypass suspicion).
