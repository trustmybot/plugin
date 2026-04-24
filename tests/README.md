# tests

Operational index for every test artifact in the plugin. **How** to run each suite, **where** the artifacts live, **how** to add a new test. For **why** the three-layer framework exists (rationale, decision tree, anti-patterns), see [`docs/testing/README.md`](../docs/testing/README.md).

## Layout

```
tests/
├── README.md                ← (you are here) operational index
├── run-all.sh               ← orchestrator — runs every automated suite
├── mcp-integration/         ← Layer 2 — real server subprocess + JSON-RPC
├── hooks/                   ← hook script tests
├── lint/                    ← agent-prompt budget + related linters
├── lib/                     ← shared shell-assert helpers
└── manual/                  ← Layer 3 — human-run against a real Claude Code session
    ├── README.md
    ├── setup.md
    └── scenarios.md
```

Layer 1 (MCP unit tests) lives at `mcp/trajectory-server/src/test/` — colocated with the source it tests, following the convention used elsewhere in that package.

## Run everything automated

```bash
# From plugin/ root:
bash tests/run-all.sh
```

Runs in order: Layer 1 unit → Layer 2 integration → hook scripts → agent-budget lint. Exit non-zero if any suite fails. CI at `.github/workflows/test.yml` runs exactly this on every PR to `dev`.

## Run an individual suite

```bash
# Layer 1 — MCP unit (handlers direct, synthetic args)
(cd mcp/trajectory-server && bun run build && node --test dist/test/*.test.js)

# Layer 2 — MCP integration (real server subprocess + JSON-RPC)
bash tests/mcp-integration/run.sh

# Hook scripts
bash tests/hooks/run.sh

# Agent-prompt budget lint
bash tests/lint/agent-line-budget.sh
```

## Run the manual suite (Layer 3)

See [`tests/manual/README.md`](./manual/README.md) — setup, scenarios, and what to do when a scenario fails.

## Add a new test

| Change | Location | Pattern |
|---|---|---|
| MCP tool handler | `mcp/trajectory-server/src/test/<name>.test.ts` | `node:test` + `node:assert/strict`; helper `tempDB()` in `src/test/helpers.ts` |
| Protocol / role / workflow | `tests/mcp-integration/<name>.test.mjs` | import from `./harness.mjs`; use `startClient()` + `call(name, args)` |
| Hook script | `tests/hooks/<name>.test.sh` | shebang + `. tests/lib/assert.sh`; call `test_case`, `assert_*`, `summarize` (see skeleton below) |
| Manual scenario | `tests/manual/scenarios.md` | follow the 8-section template at the top of that file |

### Hook test skeleton

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

Assertion helpers (`tests/lib/assert.sh`):

- `assert_eq <expected> <actual> [label]`
- `assert_contains <haystack> <needle> [label]`
- `assert_not_contains <haystack> <needle> [label]`
- `assert_exit_code <expected> <actual> [label]`
- `summarize` — prints pass/fail summary; returns non-zero if any assertion failed.

## Related

- [`docs/testing/README.md`](../docs/testing/README.md) — the **why**: rationale, decision tree, anti-patterns
- [`scripts/hooks/diagnostic/README.md`](../scripts/hooks/diagnostic/README.md) — opt-in probe-bash harness for investigating [issue #14](https://github.com/trustmybot/plugin/issues/14)
