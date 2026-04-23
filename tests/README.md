# TMB Plugin Tests

Plugin-level tests and contributor testing guide. The bundled MCP server's TypeScript unit tests live at [`mcp/trajectory-server/src/test/`](../mcp/trajectory-server/src/test/).

## Quick start — run everything

```bash
# From plugin/ root:
bash tests/run-all.sh
```

Runs, in order:
1. **MCP server suite** — TypeScript unit tests for schema + tools (~233 cases).
2. **Hook script suite** — bash unit tests for `scripts/hooks/*.sh`.

Exit code is non-zero if any suite fails.

## Individual suites

### MCP server

```bash
cd mcp/trajectory-server
bun run build
node --test dist/test/*.test.js
```

**Adding a test:** drop `src/test/<name>.test.ts` following existing patterns (e.g., `src/test/file-registry.test.ts`). Helpers at `src/test/helpers.ts`. Each file imports `node:test` + `node:assert/strict` and uses `describe` / `it`.

Key helper: `tempDB()` creates an ephemeral SQLite DB preloaded with the current schema.

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

## Local dogfood testing (end-to-end)

For setting up a scratch project and exercising the plugin end-to-end — install modes, first-run expectations, DB verification, hot reload, reset, the 10-scenario dogfood checklist, and common pitfalls — see [`docs/local-testing.md`](../docs/local-testing.md).

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
