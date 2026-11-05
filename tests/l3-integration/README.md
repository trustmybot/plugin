# L3 — Integration

Deterministic integration tests that exercise the real wiring — the MCP server as a subprocess over JSON-RPC stdio, and the hook scripts against synthetic events. L3 catches what L2 cannot: schema drift, a missing `agent` param, role-enforcement plumbing, and hook deny/inject behavior at the wire level. `tests/run-all.sh` runs the MCP tests through `mcp/run.sh` at L3; the hook suites are node:test files that run with the L2 unit tests.

| Subdir | Purpose |
|---|---|
| [`mcp/`](./mcp/) | Real server subprocess + JSON-RPC tests — role matrix, schema contract, scope gate, search tools, and per-agent workflow sequences. Shared harness in `harness.mjs`; run via `mcp/run.sh` |
| [`hooks/fixtures/`](./hooks/fixtures/) | Fixtures (goldens, legacy settings, changelog fragments, enums-stable sources) read by the hook suites, which are node:test `mcp/trajectory-server/src/test/*-l3.test.ts` files built on `src/test/hook-sandbox.ts` |

## Hermetic hook tests

- Stub `pgrep` on `PATH` in any test that runs activation-routine or mcp-health-check, so host processes don't change the result (see the stub in [`activation-routine-l3.test.ts`](../../mcp/trajectory-server/src/test/activation-routine-l3.test.ts)).
- Never assert what `sqlite3 -readonly` can open: it varies by sqlite version. Probe it and branch.
- Run each hook in a `makeSandbox` sandbox from [`hook-sandbox.ts`](../../mcp/trajectory-server/src/test/hook-sandbox.ts): its env sets `HOME` and `TMPDIR` inside the sandbox dir and inherits no `CLAUDE_*` or `TMB_*` variable.
- Create temp dirs under the sandbox or with `mkdtempSync(join(tmpdir(), ...))`, and remove them (`sandbox.remove()`) when the test ends.
- Reproduce a footprint failure with a per-test Docker loop (`node:22-bookworm` with sqlite3 and jq, as a non-root user).
